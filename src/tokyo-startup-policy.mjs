// Persistent startup intent is owned by the service, not by the login agent.
// Missing/corrupt state is inhibited; only an administrator install or a
// successful explicitly requested manual arm can re-enable it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ownedJson(file, uid, privateFile = false) {
  const parent = fs.lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & (privateFile ? 0o077 : 0o022)))
    throw Error('STARTUP_DIRECTORY_UNSAFE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || (s.mode & (privateFile ? 0o077 : 0o022)) || s.size > 8192)
      throw Error('STARTUP_FILE_UNSAFE');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function durableJson(file, data, mode = 0o600) {
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class StartupIntent {
  constructor(file, uid = process.getuid()) {
    this.file = file; this.uid = uid; this.state = { version: 1, allowed: false, reason: 'STATE_UNAVAILABLE' };
    try {
      const s = ownedJson(file, uid, true);
      if (s.version !== 1 || typeof s.allowed !== 'boolean' || !/^[A-Z_]{1,64}$/.test(s.reason || '')) throw Error('FORMAT');
      this.state = s;
    } catch { /* Do not create permissive defaults. */ }
  }
  set(allowed, reason) {
    this.state = { version: 1, allowed: false, reason: 'STATE_WRITE_FAILED' };
    const parent = fs.lstatSync(path.dirname(this.file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.uid || (parent.mode & 0o077)) throw Error('STARTUP_INTENT_UNSAFE');
    const value = { version: 1, allowed, reason, at: new Date().toISOString() };
    durableJson(this.file, value); this.state = value;
  }
  trip(reason, { transient }) {
    if (transient) return;
    if (reason === 'SHUTDOWN') {
      if (this.state.allowed) this.set(true, 'CLEAN_SHUTDOWN');
      return;
    }
    this.set(false, reason === 'MANUAL_LOCK' ? 'MANUAL_LOCK' : 'SAFETY_LOCK');
  }
  beginSession() {
    if (!this.state.allowed) return;
    // Consume the durable boot permission before exposing the control socket.
    // An unclean death (including a failed lock write) cannot replay an old
    // READY record. Only a normal shutdown grants the following boot.
    this.set(false, 'ACTIVE_SESSION'); this.state = { ...this.state, allowed: true };
  }
  ready() { this.set(false, 'ACTIVE_SESSION'); this.state = { ...this.state, allowed: true }; }
}

export function readinessRecord(record, { challenge, pid, rulesHash, now = Date.now(), maxAgeMs = 15000 }) {
  if (!record || record.version !== 1 || record.challenge !== challenge || record.pid !== pid) return 'WAITING';
  const age = now - Date.parse(record.at);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return 'WAITING';
  if (record.rulesHash !== rulesHash) return 'MISMATCH';
  if (record.status === 'WAITING') return 'WAITING';
  if (record.status !== 'VERIFIED') return 'MISMATCH';
  return 'VERIFIED';
}

export class StartupPolicy {
  constructor({ intent, latch, readReadiness, rulesHash, pid = process.pid }) {
    this.intent = intent; this.latch = latch; this.readReadiness = readReadiness; this.rulesHash = rulesHash; this.pid = pid;
    this.intent.beginSession();
    this.challenge = crypto.randomBytes(16).toString('hex'); this.used = false; this.stopped = false;
    this.state = intent.state.allowed ? 'WAITING_FOR_CLASH' : 'INHIBITED';
  }
  get snapshot() {
    const latch = this.latch.snapshot;
    const state = latch.state === 'READY' ? 'READY' : latch.state === 'VERIFYING' ? 'VERIFYING' :
      latch.recovery.wanted && latch.recovery.retryAllowed ? 'RECOVERING' :
      !this.intent.state.allowed ? 'INHIBITED' : this.state;
    return { enabled: true, state, challenge: this.challenge, resumePolicy: 'clean_shutdown_only',
    allowed: this.intent.state.allowed, inhibitReason: this.intent.state.allowed ? null : this.intent.state.reason }; }
  readiness() {
    try { return readinessRecord(this.readReadiness(), this); }
    catch (error) { return error.code === 'ENOENT' ? 'WAITING' : 'MISMATCH'; }
  }
  async step() {
    if (this.stopped || this.used) return;
    if (!this.intent.state.allowed) { this.state = 'INHIBITED'; return; }
    const s = this.latch.snapshot;
    if (s.state !== 'LOCKED' || s.lastTrip || s.coreStarts || s.history.length !== 1) {
      this.used = true; this.state = 'EXISTING_SESSION'; return;
    }
    const ready = this.readiness();
    // During boot, Clash may expose its default config before loading the
    // subscription. Wait with a closed gate until the exact baseline matches.
    // A mismatch AFTER activation is fatal via the runtime readiness guard.
    if (ready !== 'VERIFIED') { this.state = ready === 'WAITING' ? 'WAITING_FOR_CLASH' : 'WAITING_FOR_VALID_CONFIG'; return; }
    this.used = true; this.state = 'VERIFYING';
    // beginSession already consumed the durable permission. Keep only the
    // in-memory normal-shutdown permission during transient verification
    // failures: closing TUN while starting must not poison the following boot.
    // A crash still reads ACTIVE_SESSION/allowed:false; any manual/safety trip
    // revokes both permissions. No permission is granted to an inhibited boot.
    try {
      await this.latch.armAtStartup();
      this.state = this.latch.snapshot.state === 'READY' ? 'READY' :
        this.latch.snapshot.recovery.wanted ? 'RECOVERING' : 'INHIBITED';
    } catch { this.state = 'INHIBITED'; await this.latch.trip('STARTUP_POLICY_ERROR'); }
  }
  stop() { this.stopped = true; }
}
