import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TokyoEgressLatch, RECOVERY_POLICY } from './tokyo-egress-latch.mjs';
import { LANES, TOKYO_GROUP, residenceName, makePracticalConfig, validatePorts } from './tokyo-practical-config.mjs';

// Timings cover two complete residential HTTP checks, not airport ping.
export const LATENCY_POLICY = Object.freeze({ slowMs: 2500, consecutive: 2,
  minimumGainMs: 750, maximumRatio: 0.75, cooldownMs: 120000 });
export const EXIT_ENDPOINTS = Object.freeze([
  { id: 'ipify', url: 'https://api.ipify.org', trace: false },
  { id: 'cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', trace: true }
]);
const TRANSIENT_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
export class TokyoControllerError extends Error {
  constructor(diagnostic, transient = false) {
    super('TOKYO_CONTROLLER_FAILURE'); this.diagnostic = diagnostic; this.transient = transient;
  }
}

export function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw Error('TOKYO_UNSAFE_PRIVATE_DIRECTORY');
  }
}

export function privateJson(filename) {
  privateDirectory(path.dirname(filename));
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw Error('TOKYO_UNSAFE_PRIVATE_FILE');
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export function writePrivateJson(filename, data) {
  privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}

export async function checkFreePorts(ports) {
  const servers = [];
  try {
    for (const port of ports) {
      const server = net.createServer(); servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
      });
    }
  } catch { throw Error('TOKYO_PORT_IN_USE'); }
  finally { await Promise.all(servers.filter(s => s.listening).map(s => new Promise(r => s.close(r)))); }
}

export function physicalInterface() {
  const result = spawnSync('/usr/sbin/scutil', [], { input: 'show State:/Network/Global/IPv4\n',
    encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
  const name = result.stdout?.match(/PrimaryInterface\s*:\s*(\S+)/)?.[1];
  if (result.status !== 0 || !/^en\d+$/.test(name || '')) throw Error('TOKYO_PHYSICAL_INTERFACE_UNAVAILABLE');
  return name;
}

// Bounded explicit-proxy request. No curlrc, no inherited bypass/proxy variables,
// no redirects, no credentials in argv, no raw error/body logging.
export async function proxyRequest({ port, url, token, signal, timeoutSeconds = 8 }) {
  if (!Number.isInteger(port) || port < 1025 || port > 65535 || !url.startsWith('https://')) throw Error('TOKYO_INVALID_PROBE');
  if (signal?.aborted) return { code: -1, status: 0, body: '' };
  const child = spawn('/usr/bin/curl', ['-q', '--silent', '--show-error', '--noproxy', '',
    '--proxy', `http://127.0.0.1:${port}`, '--config', '-', '--connect-timeout', '5',
    '--max-time', String(timeoutSeconds), '--proto', '=https', '--write-out', '\nTOKYO_META:%{http_code} %{http_connect} %{time_appconnect}', url],
  { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(token ? `proxy-user = "probe:${token}"\n` : '');
  let body = '';
  child.stdout.on('data', value => {
    if (body.length + value.length > 32768) child.kill('SIGKILL');
    else body += value.toString();
  });
  child.stderr.resume();
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, (timeoutSeconds + 1) * 1000);
  try {
    const code = await new Promise(resolve => {
      child.once('error', () => resolve(-1)); child.once('close', code => resolve(code ?? -1));
    });
    const match = body.match(/\nTOKYO_META:(\d{3}) (\d{3}) ([\d.]+)\s*$/);
    return { code, status: Number(match?.[1] || 0), connectStatus: Number(match?.[2] || 0),
      tlsMs: Math.round(Number(match?.[3] || 0) * 1000), body: match ? body.slice(0, match.index).trim() : '' };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function inspectExit(result, expectedIp, trace = false) {
  if (result.code !== 0 || result.status !== 200) return 'UNAVAILABLE';
  const fields = trace ? Object.fromEntries(result.body.split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  })) : { ip: result.body };
  if (net.isIP(fields.ip || '') === 0) return 'UNAVAILABLE';
  if (fields.ip !== expectedIp || (trace && fields.loc !== 'JP')) return 'EXIT_MISMATCH';
  return 'VERIFIED';
}

export class TokyoPracticalRuntime {
  constructor({ settings, directory, binary, intervalMs = 15000, checkTimeoutMs = 40000,
    recovery = RECOVERY_POLICY, request = proxyRequest, controllerFetch = fetch,
    readinessCheck, onTrip, onReady }) {
    privateDirectory(directory); validatePorts(settings.ports);
    if (process.getuid() === 0 || settings.uid !== process.getuid()) throw Error('TOKYO_RUNTIME_IDENTITY_MISMATCH');
    if (!path.isAbsolute(binary)) throw Error('TOKYO_INVALID_BINARY');
    this.settings = structuredClone(settings); this.directory = directory; this.binary = binary;
    this.token = crypto.randomBytes(24).toString('hex'); this.child = null; this.selectedLane = null;
    this.probeHistory = []; this.switches = 0; this.closingCore = false;
    this.slowStreak = 0; this.lastLatencyAttempt = -Infinity;
    this.lastSwitch = null; this.lastSwitchTick = -Infinity;
    this.lastCheckFailure = null; this.request = request; this.recoveryPolicy = structuredClone(recovery);
    this.controllerFetch = controllerFetch; this.checkStage = 'IDLE'; this.checkDiagnostics = [];
    this.latch = new TokyoEgressLatch({ gatePort: settings.ports.gate, upstreamPort: settings.ports.upstream,
      intervalMs, checkTimeoutMs, recovery, onTrip, onReady, startCore: async signal => {
        try { return await this.startCore(signal); } catch (error) {
          // Configuration, permissions, port collisions and identity failures
          // are not treated as temporary network outages.
          error.retryable = (error instanceof TokyoControllerError && error.transient) ||
            ['TOKYO_PHYSICAL_INTERFACE_UNAVAILABLE', 'TOKYO_CORE_NOT_READY'].includes(error.message);
          throw error;
        }
      }, stopCore: () => this.stopCore(), checkExit: async signal => {
        const ready = () => readinessCheck ? readinessCheck() : 'VERIFIED';
        const fail = state => {
          this.lastCheckFailure = state === 'WAITING' ? 'UNAVAILABLE' : 'CHECK_ERROR';
          return { healthy: false, failure: this.lastCheckFailure };
        };
        let state = ready(); if (state !== 'VERIFIED') return fail(state);
        const healthy = await this.checkExit(signal);
        if (!healthy) return { healthy: false, failure: this.lastCheckFailure };
        state = ready(); if (state !== 'VERIFIED') return fail(state);
        return { healthy: true };
      } });
  }
  get snapshot() {
    return { scope: 'explicit_proxy_only_not_system_firewall', pid: process.pid, uid: process.getuid(),
      gatePort: this.settings.ports.gate, selectedLane: this.selectedLane, switches: this.switches,
      coreRunning: !!this.child && this.child.exitCode === null && this.child.signalCode === null,
      latch: this.latch.snapshot, probes: this.probeHistory.slice(-60),
      latencyPolicy: LATENCY_POLICY, recoveryPolicy: this.latch.snapshot.recovery.enabled ? this.recoveryPolicy : null,
      slowStreak: this.slowStreak, lastSwitch: this.lastSwitch, lastCheckFailure: this.lastCheckFailure,
      checkStage: this.checkStage, checkDiagnostics: this.checkDiagnostics.slice(-8) };
  }
  async api(route, options = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(2500), ...(options.signal ? [options.signal] : [])]);
    let response;
    try {
      response = await this.controllerFetch(`http://127.0.0.1:${this.settings.ports.controller}${route}`, {
        ...options, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw new TokyoControllerError('ABORTED');
      if (error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError')
        throw new TokyoControllerError('TIMEOUT', true);
      const code = error?.cause?.code || error?.code;
      if (TRANSIENT_TRANSPORT_CODES.has(code)) throw new TokyoControllerError(code, true);
      throw new TokyoControllerError('UNCLASSIFIED_FETCH');
    }
    if (!response.ok) throw new TokyoControllerError(`HTTP_${response.status}`, TRANSIENT_HTTP.has(response.status));
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch (error) {
      if (options.signal?.aborted) throw new TokyoControllerError('ABORTED');
      if (signal.reason?.name === 'TimeoutError') throw new TokyoControllerError('TIMEOUT', true);
      const code = error?.cause?.code || error?.code;
      if (TRANSIENT_TRANSPORT_CODES.has(code)) throw new TokyoControllerError(code, true);
      throw new TokyoControllerError('INVALID_RESPONSE');
    }
  }
  async startCore(signal) {
    if (this.snapshot.coreRunning || signal.aborted) throw Error('TOKYO_CORE_START_STATE');
    await checkFreePorts(['upstream', 'controller', ...LANES].map(k => this.settings.ports[k]));
    this.selectedLane = null;
    this.slowStreak = 0; this.lastLatencyAttempt = -Infinity; this.lastSwitchTick = -Infinity;
    this.config = makePracticalConfig({ ...this.settings, interfaceName: physicalInterface(), token: this.token });
    const configPath = path.join(this.directory, 'core.private.json');
    writePrivateJson(configPath, this.config);
    const checked = spawnSync(this.binary, ['-t', '-d', this.directory, '-f', configPath],
      { timeout: 15000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    if (checked.status !== 0 || signal.aborted) throw Error('TOKYO_CORE_CONFIG_INVALID');
    const child = spawn(this.binary, ['-d', this.directory, '-f', configPath],
      { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, detached: false });
    this.child = child;
    child.on('error', () => { if (!this.closingCore) void this.latch.trip('CORE_ERROR'); });
    child.once('exit', () => { if (!this.closingCore) void this.latch.trip('CORE_EXIT'); });
    for (let i = 0; i < 50 && !signal.aborted; i++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const actual = await this.api('/configs');
        if (!actual || actual.tun?.enable || actual.mode !== 'rule' || actual['mixed-port'] !== this.settings.ports.upstream) {
          throw Error('TOKYO_RUNTIME_CONFIG_MISMATCH');
        }
        return;
      } catch (error) {
        if (error.message === 'TOKYO_RUNTIME_CONFIG_MISMATCH' ||
            (error instanceof TokyoControllerError && !error.transient)) throw error;
      }
      await delay(100);
    }
    throw Error('TOKYO_CORE_NOT_READY');
  }
  async stopCore() {
    const child = this.child;
    if (!child) return true;
    this.closingCore = true;
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
      return child.exitCode !== null || child.signalCode !== null;
    } finally { this.closingCore = false; }
  }
  async probeLane(lane, signal) {
    if (!LANES.includes(lane) || !this.snapshot.coreRunning || signal?.aborted) return 'UNAVAILABLE';
    const started = performance.now();
    const endpoints = []; let failure; let outcome = 'VERIFIED';
    for (const endpoint of EXIT_ENDPOINTS) {
      const began = performance.now();
      const result = await this.request({ port: this.settings.ports[lane], url: endpoint.url, token: this.token, signal });
      const verdict = inspectExit(result, this.settings.intake.expectedExit.ipv4, endpoint.trace);
      endpoints.push({ endpoint: endpoint.id, outcome: verdict, milliseconds: Math.round(performance.now() - began),
        transportCode: result.code, httpStatus: result.status,
        connectStatus: result.connectStatus ?? 0, tlsMs: result.tlsMs ?? 0 });
      if (verdict !== 'VERIFIED') {
        failure ??= { endpoint: endpoint.id, transportCode: result.code, httpStatus: result.status };
        outcome = verdict;
      }
      if (signal?.aborted || verdict === 'EXIT_MISMATCH') break;
      // A transport failure does NOT suppress the independent diagnostic.
      // Both endpoints must still verify; this adds evidence, not fail-open.
    }
    if (signal?.aborted) outcome = 'UNAVAILABLE';
    this.recordProbe(lane, outcome, started, failure, endpoints); return outcome;
  }
  recordProbe(lane, outcome, started, failure, endpoints) {
    this.probeHistory.push({ lane, outcome, milliseconds: Math.round(performance.now() - started),
      at: new Date().toISOString(), ...(failure ? { failure } : {}), ...(endpoints ? { endpoints } : {}) });
    this.probeHistory = this.probeHistory.slice(-60);
    // Fixed native helper accepts 32 KiB and pretty-prints its response. Bound
    // the detailed history too, so diagnosis cannot break the status indicator.
    while (this.probeHistory.length > 1 && JSON.stringify(this.probeHistory, null, 2).length > 18000) this.probeHistory.shift();
  }
  async selectVerified(lane, signal, reason) {
    if (signal.aborted || !this.snapshot.coreRunning) return false;
    const route = `/proxies/${TOKYO_GROUP}`;
    // Do not rewrite an unchanged selector every health cycle. Still read it
    // back: silently retaining a tampered selection would weaken protection.
    if (this.selectedLane !== lane) {
      this.checkStage = 'WRITE_SELECTION';
      await this.api(route, { method: 'PUT', body: JSON.stringify({ name: residenceName(lane) }), signal });
    }
    this.checkStage = 'READ_SELECTION';
    const actual = await this.api(route, { signal });
    if (signal.aborted) return false;
    if (actual?.now !== residenceName(lane)) throw new TokyoControllerError('SELECTION_MISMATCH');
    if (this.selectedLane !== lane) {
      const from = this.selectedLane;
      if (from) {
        this.checkStage = 'CLOSE_OLD_CONNECTIONS';
        await this.api('/connections', { method: 'DELETE', signal }); this.switches++;
      }
      if (signal.aborted) return false;
      this.lastSwitch = { from, to: lane, reason, at: new Date().toISOString() };
      this.lastSwitchTick = performance.now(); this.slowStreak = 0;
    }
    this.selectedLane = lane; return true;
  }
  async considerFasterLane(lane, signal) {
    const sample = this.probeHistory.at(-1);
    const ms = sample?.lane === lane && sample.outcome === 'VERIFIED' ? sample.milliseconds : NaN;
    this.slowStreak = Number.isFinite(ms) && ms >= LATENCY_POLICY.slowMs ? this.slowStreak + 1 : 0;
    const now = performance.now();
    if (this.slowStreak < LATENCY_POLICY.consecutive ||
        now - this.lastSwitchTick < LATENCY_POLICY.cooldownMs ||
        now - this.lastLatencyAttempt < LATENCY_POLICY.cooldownMs) return lane;
    this.lastLatencyAttempt = now;
    const alternate = LANES.find(x => x !== lane);
    this.checkStage = 'PROBE_ALTERNATE';
    const outcome = await this.probeLane(alternate, signal);
    // Identity failures remain fatal, including in a candidate tested for speed.
    if (outcome === 'EXIT_MISMATCH') this.lastCheckFailure = 'EXIT_MISMATCH';
    if (outcome === 'EXIT_MISMATCH' || signal.aborted) return null;
    const candidate = this.probeHistory.at(-1);
    if (outcome === 'VERIFIED' && candidate?.lane === alternate &&
        Number.isFinite(candidate.milliseconds) && candidate.milliseconds >= 0 &&
        ms - candidate.milliseconds >= LATENCY_POLICY.minimumGainMs &&
        candidate.milliseconds <= ms * LATENCY_POLICY.maximumRatio) return alternate;
    return lane; // A failed/slower alternate never replaces a verified current chain.
  }
  async checkExit(signal) {
    this.lastCheckFailure = 'CHECK_ERROR';
    try { return await this.checkExitOnce(signal); }
    catch (error) {
      const controller = error instanceof TokyoControllerError;
      this.lastCheckFailure = controller && error.transient && !signal.aborted ? 'CONTROLLER_UNAVAILABLE' : 'CHECK_ERROR';
      // Never retain exception messages, stack traces, URLs, tokens or bodies.
      const code = controller && /^(TIMEOUT|ABORTED|UNCLASSIFIED_FETCH|INVALID_RESPONSE|SELECTION_MISMATCH|HTTP_\d{3}|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(error.diagnostic)
        ? error.diagnostic : 'UNCLASSIFIED_EXCEPTION';
      this.checkDiagnostics.push({ at: new Date().toISOString(), stage: this.checkStage,
        failure: this.lastCheckFailure, code });
      this.checkDiagnostics = this.checkDiagnostics.slice(-8);
      return false;
    }
  }
  async checkExitOnce(signal) {
    const order = this.selectedLane ? [this.selectedLane, ...LANES.filter(x => x !== this.selectedLane)] : LANES;
    for (const lane of order) {
      if (signal.aborted || !this.snapshot.coreRunning) return false;
      this.checkStage = 'PROBE_EXIT';
      const result = await this.probeLane(lane, signal);
      // An unexpected working exit is an identity fault, not ordinary latency.
      if (result === 'EXIT_MISMATCH') this.lastCheckFailure = 'EXIT_MISMATCH';
      if (result === 'EXIT_MISMATCH' || signal.aborted) return false;
      if (result !== 'VERIFIED') continue;
      const candidate = lane === this.selectedLane ? await this.considerFasterLane(lane, signal) : lane;
      if (!candidate || signal.aborted) return false;
      const selected = await this.selectVerified(candidate, signal, candidate !== lane ? 'LATENCY_DEGRADED' :
        this.selectedLane && this.selectedLane !== lane ? 'ACTIVE_CHAIN_FAILED' : 'EXIT_VERIFIED');
      if (selected) this.lastCheckFailure = null;
      return selected;
    }
    this.lastCheckFailure = 'UNAVAILABLE';
    return false;
  }
  async listen() { await this.latch.listen(); }
  async close() { await this.latch.close(); return this.stopCore(); }
}
