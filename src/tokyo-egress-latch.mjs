import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const RECOVERY_POLICY = Object.freeze({ enabled: true, delaysMs: [30000, 60000, 120000],
  confirmations: 2, confirmationGapMs: 5000 });

async function bounded(promise, ms, fallback) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { clearTimeout(timer); }
}

// Process-level fail-closed gate. This is not an OS guard or a daemon installer.
// Its upstream MUST be the separate no-fallback Tokyo core. Authentication is
// controlled by that core; loopback binding alone is NOT an inter-user boundary.
export class TokyoEgressLatch {
  #state = 'LOCKED';
  #generation = 0;
  #timer = null;
  #checking = null;
  #stopping = null;
  #server = null;
  #sockets = new Set();
  #abort = null;
  #startAbort = null;
  #starting = null;
  #options;
  #history = ['LOCKED'];
  #lastTrip = null;
  #checkFailure = null;
  #recoveryTimer = null;
  #recoveryWanted = false;
  #retryAllowed = false;
  #recoveryAttempts = 0;
  #backoff = 0;
  #nextRetryAt = null;
  #lastRecoveredAt = null;
  #pauseAbort = null;
  #counts = { coreStarts: 0, coreStops: 0, exitChecks: 0, upstreamDials: 0, rejectedClients: 0, socketsDestroyedByLatch: 0 };

  constructor(options) {
    const port = n => Number.isInteger(n) && n > 1024 && n <= 65535;
    if (!port(options.gatePort) || !port(options.upstreamPort) || options.gatePort === options.upstreamPort ||
        !Number.isInteger(options.intervalMs) || options.intervalMs < 20 ||
        !Number.isInteger(options.checkTimeoutMs) || options.checkTimeoutMs < 20 ||
        !['startCore', 'stopCore', 'checkExit'].every(k => typeof options[k] === 'function')) {
      throw new Error('LATCH_INVALID_OPTIONS');
    }
    this.#options = { ...options };
    const recovery = options.recovery ?? { ...RECOVERY_POLICY, enabled: false };
    if (typeof recovery.enabled !== 'boolean' || !Array.isArray(recovery.delaysMs) || !recovery.delaysMs.length ||
        recovery.delaysMs.some(n => !Number.isInteger(n) || n < 20 || n > 3600000) ||
        !Number.isInteger(recovery.confirmations) || recovery.confirmations < 2 || recovery.confirmations > 5 ||
        !Number.isInteger(recovery.confirmationGapMs) || recovery.confirmationGapMs < 20) throw Error('LATCH_INVALID_RECOVERY');
    this.#options.recovery = structuredClone(recovery);
  }
  get snapshot() {
    return { state: this.#state, history: [...this.#history], ...this.#counts,
      openSockets: this.#sockets.size, healthTimerScheduled: this.#timer !== null, lastTrip: this.#lastTrip,
      recovery: { enabled: this.#options.recovery.enabled, wanted: this.#recoveryWanted,
        retryAllowed: this.#retryAllowed, timerScheduled: this.#recoveryTimer !== null,
        nextRetryAt: this.#nextRetryAt, attempts: this.#recoveryAttempts, lastRecoveredAt: this.#lastRecoveredAt } };
  }
  #transition(state) { this.#state = state; this.#history.push(state); this.#history = this.#history.slice(-64); }
  async listen() {
    if (this.#server || this.#state !== 'LOCKED') throw new Error('LATCH_LISTEN_STATE');
    const server = net.createServer(client => {
      client.on('error', () => {});
      if (this.#state !== 'READY') { this.#counts.rejectedClients++; client.destroy(); return; }
      this.#counts.upstreamDials++;
      const upstream = net.createConnection({ host: '127.0.0.1', port: this.#options.upstreamPort });
      this.#sockets.add(client); this.#sockets.add(upstream);
      const destroyPair = () => { client.destroy(); upstream.destroy(); };
      client.once('close', () => { this.#sockets.delete(client); upstream.destroy(); });
      upstream.once('close', () => { this.#sockets.delete(upstream); client.destroy(); });
      client.on('error', destroyPair);
      upstream.on('error', () => { destroyPair(); void this.trip('UPSTREAM_SOCKET_ERROR'); });
      client.pipe(upstream).pipe(client);
    });
    this.#server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.#options.gatePort, '127.0.0.1', resolve); });
      server.on('error', () => { void this.trip('GATE_ERROR'); });
    } catch { this.#server = null; throw new Error('LATCH_BIND_FAILED'); }
  }
  async #check(generation) {
    if (this.#checking) return false; // Never overlap health probes.
    this.#checkFailure = null;
    const abort = new AbortController();
    this.#abort = abort;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { this.#checkFailure = 'CHECK_TIMEOUT'; abort.abort(); resolve(false); }, this.#options.checkTimeoutMs);
    });
    this.#counts.exitChecks++;
    const checking = Promise.resolve().then(() => this.#options.checkExit(abort.signal)).then(value => {
      if (abort.signal.aborted || generation !== this.#generation) return false;
      const healthy = value === true || value?.healthy === true;
      if (!healthy) this.#checkFailure = ['UNAVAILABLE', 'CONTROLLER_UNAVAILABLE', 'EXIT_MISMATCH'].includes(value?.failure) ? value.failure : 'CHECK_ERROR';
      return healthy;
    }, () => { if (!abort.signal.aborted && generation === this.#generation) this.#checkFailure = 'CHECK_ERROR'; return false; });
    this.#checking = checking;
    // A timed-out implementation may ignore abort. Keep it registered until it
    // settles, so a recovery attempt cannot overlap it or use its late result.
    void checking.finally(() => { if (this.#checking === checking) this.#checking = null; });
    try {
      const healthy = await Promise.race([checking, timeout]);
      return healthy && generation === this.#generation && !abort.signal.aborted;
    } finally {
      clearTimeout(timer);
      if (this.#abort === abort) this.#abort = null;
    }
  }
  #schedule(generation) {
    if (this.#state !== 'READY' || generation !== this.#generation) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      if (this.#state !== 'READY' || generation !== this.#generation) return;
      if (!await this.#check(generation)) {
        if (generation === this.#generation && this.#state === 'READY') await this.trip(
          this.#checkFailure === 'EXIT_MISMATCH' ? 'EXIT_MISMATCH' : 'EXIT_HEALTH_FAILED');
      } else this.#schedule(generation);
    }, this.#options.intervalMs);
  }
  #clearRecoveryTimer() {
    clearTimeout(this.#recoveryTimer); this.#recoveryTimer = null; this.#nextRetryAt = null;
  }
  #scheduleRecovery() {
    this.#clearRecoveryTimer();
    if (!this.#recoveryWanted || !this.#retryAllowed || this.#state !== 'LOCKED') return;
    const generation = this.#generation, policy = this.#options.recovery;
    const ms = policy.delaysMs[Math.min(this.#backoff, policy.delaysMs.length - 1)];
    this.#nextRetryAt = new Date(Date.now() + ms).toISOString();
    this.#recoveryTimer = setTimeout(async () => {
      this.#recoveryTimer = null; this.#nextRetryAt = null;
      if (generation !== this.#generation || this.#state !== 'LOCKED' || !this.#recoveryWanted || !this.#retryAllowed) return;
      if (this.#checking || this.#stopping) { this.#scheduleRecovery(); return; }
      try { await this.#arm(true); } catch { await this.trip('RECOVERY_ERROR'); }
    }, ms);
  }
  async armManually() { return this.#arm(false); }
  async armAtStartup() {
    // One startup attempt only. Never turn a later manual/safety lock into a
    // new startup authorization, including when a login agent is restarted.
    if (this.#history.length !== 1 || this.#lastTrip || this.#counts.coreStarts || this.#checking || this.#stopping)
      throw Error('LATCH_STARTUP_ALREADY_CONSUMED');
    this.#recoveryWanted = this.#options.recovery.enabled;
    return this.#arm(true, true);
  }
  async #arm(automatic, startup = false) {
    if (!this.#server?.listening || this.#state !== 'LOCKED' || this.#stopping || this.#checking) {
      throw new Error('LATCH_ARM_STATE');
    }
    this.#clearRecoveryTimer();
    if (automatic && !startup) { this.#recoveryAttempts++; this.#backoff++; }
    else { this.#recoveryWanted = this.#options.recovery.enabled; this.#backoff = 0; }
    this.#retryAllowed = false;
    const generation = ++this.#generation;
    this.#transition('VERIFYING');
    try {
      this.#counts.coreStarts++;
      this.#startAbort = new AbortController();
      const abort = this.#startAbort;
      const starting = Promise.resolve().then(() => this.#options.startCore(abort.signal));
      this.#starting = starting;
      const completed = await bounded(starting.then(() => 'OK', error => error?.retryable === true ? 'TRANSIENT' : 'FAILED'),
        this.#options.checkTimeoutMs, 'TRANSIENT');
      if (generation !== this.#generation) return false;
      if (completed !== 'OK') {
        abort.abort(); await this.trip(completed === 'TRANSIENT' ? 'CORE_START_TRANSIENT' : 'CORE_START_FAILED'); return false;
      }
      if (this.#starting === starting) this.#starting = null;
      if (generation !== this.#generation) return false;
      const confirmations = automatic ? this.#options.recovery.confirmations : 1;
      for (let i = 0; i < confirmations; i++) {
        if (i) {
          const pause = new AbortController(); this.#pauseAbort = pause;
          await delay(this.#options.recovery.confirmationGapMs, null, { signal: pause.signal }).catch(() => {});
          if (this.#pauseAbort === pause) this.#pauseAbort = null;
          if (generation !== this.#generation || pause.signal.aborted) return false;
        }
        if (!await this.#check(generation)) {
          if (generation === this.#generation) await this.trip(
            this.#checkFailure === 'EXIT_MISMATCH' ? 'EXIT_MISMATCH' : 'INITIAL_EXIT_UNVERIFIED');
          return false;
        }
      }
      if (generation !== this.#generation || this.#state !== 'VERIFYING') return false;
      // Synchronous durable intent update must succeed before opening the gate.
      this.#options.onReady?.();
      if (automatic && !startup) this.#lastRecoveredAt = new Date().toISOString();
      this.#backoff = 0; this.#transition('READY'); this.#schedule(generation); return true;
    } catch { if (generation === this.#generation) await this.trip('START_OR_VERIFY_FAILED'); return false; }
  }
  trip(reason = 'MANUAL_LOCK') {
    let transient = ['CORE_EXIT', 'CORE_ERROR', 'UPSTREAM_SOCKET_ERROR', 'CORE_START_TRANSIENT'].includes(reason) ||
      (['EXIT_HEALTH_FAILED', 'INITIAL_EXIT_UNVERIFIED'].includes(reason) && ['UNAVAILABLE', 'CHECK_TIMEOUT', 'CONTROLLER_UNAVAILABLE'].includes(this.#checkFailure));
    // Persist manual/fatal inhibition even if already locked. Storage failure
    // must not prevent closing sockets, nor leave a recovery timer enabled.
    try { this.#options.onTrip?.(reason, { transient }); }
    catch { transient = false; }
    // A manual lock must also cancel a queued retry while already LOCKED or
    // CLOSING. It cannot be undone by the earlier stop promise's completion.
    if (!transient) this.#recoveryWanted = false;
    this.#retryAllowed = transient && this.#recoveryWanted;
    this.#clearRecoveryTimer(); this.#pauseAbort?.abort();
    if (this.#stopping) return this.#stopping;
    if (this.#state === 'LOCKED' || this.#state === 'STOPPED') {
      if (reason === 'MANUAL_LOCK') this.#lastTrip = { reason, at: new Date().toISOString() };
      return Promise.resolve(this.#state);
    }
    this.#lastTrip = { reason: ['MANUAL_LOCK', 'SHUTDOWN', 'EXIT_HEALTH_FAILED', 'INITIAL_EXIT_UNVERIFIED',
      'CORE_START_FAILED', 'CORE_START_TRANSIENT', 'START_OR_VERIFY_FAILED', 'CORE_ERROR', 'CORE_EXIT',
      'UPSTREAM_SOCKET_ERROR', 'GATE_ERROR', 'EXIT_MISMATCH', 'RECOVERY_ERROR'].includes(reason)
      ? reason : 'UNKNOWN', at: new Date().toISOString(),
      ...(['EXIT_HEALTH_FAILED', 'INITIAL_EXIT_UNVERIFIED'].includes(reason) ? { failure: this.#checkFailure } : {}) };
    ++this.#generation;
    this.#transition('CLOSING');
    clearTimeout(this.#timer); this.#timer = null;
    this.#abort?.abort();
    this.#startAbort?.abort();
    // server.close() alone would leave established streams alive. Destroy both
    // sides first; reject new clients immediately while stopping the core.
    for (const socket of this.#sockets) {
      if (!socket.destroyed) this.#counts.socketsDestroyedByLatch++;
      socket.destroy();
    }
    const starting = this.#starting;
    this.#stopping = Promise.resolve().then(async () => {
      const stop = async () => {
        this.#counts.coreStops++;
        return bounded(Promise.resolve().then(() => this.#options.stopCore()).then(v => v === true, () => false),
          this.#options.checkTimeoutMs, false);
      };
      const stopped = await stop();
      if (!starting) return stopped;
      // A start that finishes after the first stop could otherwise leave an
      // orphan core. Do not mark LOCKED/rearmable until that race is settled.
      const settled = await bounded(starting.then(() => true, () => true), this.#options.checkTimeoutMs, false);
      if (!settled) return false;
      if (this.#starting === starting) this.#starting = null;
      return await stop();
    }).then(stopped => {
      this.#transition(stopped === true ? 'LOCKED' : 'STOP_UNCONFIRMED');
      return this.#state;
    }, () => { this.#transition('STOP_UNCONFIRMED'); return this.#state; }).finally(() => {
      this.#stopping = null;
      if (this.#state === 'STOP_UNCONFIRMED') { this.#retryAllowed = false; this.#recoveryWanted = false; }
      this.#scheduleRecovery();
    });
    return this.#stopping;
  }
  async close() {
    await this.trip('SHUTDOWN');
    if (this.#server) {
      await new Promise(resolve => this.#server.close(resolve));
      this.#server = null;
    }
    if (this.#state !== 'STOP_UNCONFIRMED') this.#transition('STOPPED');
  }
}
