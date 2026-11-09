import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TokyoEgressLatch, RECOVERY_POLICY } from '../src/tokyo-egress-latch.mjs';
import { TokyoPracticalRuntime } from '../src/tokyo-practical-runtime.mjs';
import { DEFAULT_PORTS } from '../src/tokyo-practical-config.mjs';

const policy = { enabled: true, delaysMs: [80, 120, 160], confirmations: 2, confirmationGapMs: 30 };
async function until(fn) { for (let i = 0; i < 500 && !fn(); i++) await delay(5); assert.ok(fn()); }
async function fixture(t, options = {}) {
  const clients = new Set(), echo = net.createServer(c => { clients.add(c); c.on('error', () => {}); c.pipe(c); c.on('close', () => clients.delete(c)); });
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const temp = net.createServer(); await new Promise(r => temp.listen(0, '127.0.0.1', r));
  const gatePort = temp.address().port; await new Promise(r => temp.close(r));
  let healthy = true;
  const latch = new TokyoEgressLatch({ gatePort, upstreamPort: echo.address().port, intervalMs: 25,
    checkTimeoutMs: 100, recovery: policy, startCore: async () => {}, stopCore: async () => true,
    checkExit: async () => ({ healthy, failure: 'UNAVAILABLE' }), ...options });
  await latch.listen();
  t.after(async () => { await latch.close(); for (const c of clients) c.destroy(); await new Promise(r => echo.close(r)); });
  return { latch, gatePort, healthy: v => { healthy = v; } };
}
async function denied(f) {
  const before = f.latch.snapshot.upstreamDials;
  const c = net.connect(f.gatePort, '127.0.0.1'); c.on('error', () => {});
  await until(() => c.destroyed); assert.equal(f.latch.snapshot.upstreamDials, before);
}
test('automatic recovery is opt-in and never opens on service startup', async t => {
  const f = await fixture(t); await delay(120);
  assert.equal(f.latch.snapshot.state, 'LOCKED'); assert.equal(f.latch.snapshot.coreStarts, 0);
  assert.equal(f.latch.snapshot.recovery.wanted, false); await denied(f);
  assert.deepEqual(RECOVERY_POLICY.delaysMs, [30000, 60000, 120000]);
});
test('transient failure closes old stream and auto-recovers only after two new complete checks', async t => {
  let recovering = false, confirmations = 0, finishSecond;
  const f = await fixture(t, { checkExit: async () => {
    if (!recovering) return { healthy: true };
    if (++confirmations === 1) return { healthy: false, failure: 'UNAVAILABLE' };
    if (confirmations === 3) return new Promise(r => { finishSecond = r; });
    return { healthy: true };
  } });
  assert.equal(await f.latch.armManually(), true);
  const held = net.connect(f.gatePort, '127.0.0.1'); held.on('error', () => {});
  await new Promise(r => held.once('connect', r));
  const echoed = new Promise(r => held.once('data', r)); held.write('test'); await echoed;
  recovering = true;
  await until(() => f.latch.snapshot.state === 'LOCKED'); await until(() => held.destroyed);
  assert.equal(f.latch.snapshot.recovery.timerScheduled, true); await denied(f);
  await until(() => !!finishSecond); assert.equal(f.latch.snapshot.state, 'VERIFYING'); await denied(f);
  finishSecond({ healthy: true }); await until(() => f.latch.snapshot.state === 'READY');
  assert.equal(f.latch.snapshot.recovery.attempts, 1); assert.ok(f.latch.snapshot.recovery.lastRecoveredAt);
});
test('failed recovery retries with bounded backoff and is not limited to one attempt', async t => {
  const f = await fixture(t); await f.latch.armManually(); f.healthy(false);
  await until(() => f.latch.snapshot.recovery.attempts >= 2 && f.latch.snapshot.state === 'LOCKED');
  assert.ok(Date.parse(f.latch.snapshot.recovery.nextRetryAt) - Date.now() <= 160);
  await denied(f); f.healthy(true); await until(() => f.latch.snapshot.state === 'READY');
  assert.ok(f.latch.snapshot.recovery.attempts >= 3);
});
test('manual lock while already LOCKED cancels every queued automatic attempt', async t => {
  const f = await fixture(t); await f.latch.armManually(); f.healthy(false);
  await until(() => f.latch.snapshot.state === 'LOCKED'); await f.latch.trip('MANUAL_LOCK');
  f.healthy(true); const starts = f.latch.snapshot.coreStarts; await delay(250);
  assert.equal(f.latch.snapshot.state, 'LOCKED'); assert.equal(f.latch.snapshot.coreStarts, starts);
  assert.equal(f.latch.snapshot.recovery.wanted, false); assert.equal(f.latch.snapshot.recovery.timerScheduled, false);
});
test('manual lock during recovery verification cannot be undone by late success', async t => {
  let n = 0, complete;
  const f = await fixture(t, { checkExit: async () => {
    if (++n === 1) return true;
    if (n === 2) return { healthy: false, failure: 'UNAVAILABLE' };
    return new Promise(r => { complete = r; });
  } });
  await f.latch.armManually(); await until(() => !!complete);
  await f.latch.trip(); complete(true); await delay(150);
  assert.equal(f.latch.snapshot.state, 'LOCKED'); assert.equal(f.latch.snapshot.recovery.timerScheduled, false);
});
for (const failure of ['EXIT_MISMATCH', 'CHECK_ERROR']) {
  test(`${failure} never enables automatic recovery`, async t => {
    const f = await fixture(t, { checkExit: async () => ({ healthy: false, failure }) });
    assert.equal(await f.latch.armManually(), false); await delay(130);
    assert.equal(f.latch.snapshot.coreStarts, 1); assert.equal(f.latch.snapshot.recovery.timerScheduled, false);
    if (failure === 'EXIT_MISMATCH') assert.equal(f.latch.snapshot.lastTrip.reason, failure);
  });
}
test('exit mismatch encountered during an automatic attempt stops further attempts', async t => {
  let n = 0;
  const f = await fixture(t, { checkExit: async () => ++n === 1 ? true :
    ({ healthy: false, failure: n === 2 ? 'UNAVAILABLE' : 'EXIT_MISMATCH' }) });
  await f.latch.armManually(); await until(() => f.latch.snapshot.lastTrip?.reason === 'EXIT_MISMATCH');
  await delay(180); assert.equal(f.latch.snapshot.recovery.attempts, 1); await denied(f);
});
test('unconfirmed stop prevents all automatic restarts', async t => {
  const f = await fixture(t, { stopCore: async () => false }); await f.latch.armManually(); f.healthy(false);
  await until(() => f.latch.snapshot.state === 'STOP_UNCONFIRMED'); await delay(150);
  assert.equal(f.latch.snapshot.coreStarts, 1); assert.equal(f.latch.snapshot.recovery.timerScheduled, false);
});
test('manual lock during slow stopping cancels the pending retry', async t => {
  let stopped;
  const f = await fixture(t, { stopCore: () => new Promise(r => { stopped = r; }) });
  await f.latch.armManually(); f.healthy(false); await until(() => !!stopped);
  const lock = f.latch.trip(); stopped(true); await lock; await delay(150);
  assert.equal(f.latch.snapshot.state, 'LOCKED'); assert.equal(f.latch.snapshot.recovery.timerScheduled, false);
});
test('core crash may recover; start configuration failure may not', async t => {
  const f = await fixture(t); await f.latch.armManually(); await f.latch.trip('CORE_EXIT');
  await until(() => f.latch.snapshot.state === 'READY'); assert.equal(f.latch.snapshot.recovery.attempts, 1);
  const g = await fixture(t, { startCore: async () => { throw Error('configuration'); } });
  assert.equal(await g.latch.armManually(), false); await delay(150);
  assert.equal(g.latch.snapshot.coreStarts, 1); assert.equal(g.latch.snapshot.recovery.timerScheduled, false);
});
test('temporary physical network unavailability retries core startup', async t => {
  let starts = 0;
  const f = await fixture(t, { startCore: async () => { if (++starts === 1) throw Object.assign(Error('offline'), { retryable: true }); } });
  assert.equal(await f.latch.armManually(), false); await until(() => f.latch.snapshot.state === 'READY');
  assert.equal(starts, 2);
});
test('hung health check cannot overlap a retry or open gate with a late result', async t => {
  let finish, active = 0, max = 0;
  const f = await fixture(t, { checkExit: () => { active++; max = Math.max(active, max); return new Promise(r => {
    finish = v => { active--; r(v); };
  }); } });
  assert.equal(await f.latch.armManually(), false); await delay(220);
  assert.equal(max, 1); assert.equal(f.latch.snapshot.coreStarts, 1); await denied(f);
  finish(true); await delay(20); assert.notEqual(f.latch.snapshot.state, 'READY'); assert.equal(max, 1);
  await f.latch.trip();
});

function runtimeFixture(t, request) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-endpoint-unit-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const r = new TokyoPracticalRuntime({ directory, binary: '/bin/false', request,
    settings: { uid: process.getuid(), ports: DEFAULT_PORTS, intake: { expectedExit: { ipv4: '192.0.2.10' } } } });
  r.child = { exitCode: null, signalCode: null }; return r;
}
test('ipify failure does not suppress Cloudflare evidence, and one success cannot open gate', async t => {
  const requests = [];
  const r = runtimeFixture(t, async ({ url }) => { requests.push(url); return url.includes('ipify') ?
    { code: 35, status: 0, body: '', connectStatus: 200 } : { code: 0, status: 200, body: 'ip=192.0.2.10\nloc=JP' }; });
  assert.equal(await r.probeLane('nexitally', new AbortController().signal), 'UNAVAILABLE');
  assert.equal(requests.length, 2); assert.deepEqual(r.snapshot.probes.at(-1).endpoints.map(e => e.outcome), ['UNAVAILABLE', 'VERIFIED']);
  assert.equal(r.snapshot.probes.at(-1).failure.transportCode, 35);
});
test('second endpoint identity mismatch is fatal even if first was unavailable', async t => {
  const r = runtimeFixture(t, async ({ url }) => url.includes('ipify') ? { code: 28, status: 0, body: '' } :
    { code: 0, status: 200, body: 'ip=192.0.2.99\nloc=JP' });
  assert.equal(await r.probeLane('nexitally', new AbortController().signal), 'EXIT_MISMATCH');
});
test('diagnostic output never includes raw bodies or credentials and fits native helper bounds', async t => {
  const r = runtimeFixture(t, async () => ({ code: 0, status: 200, body: 'secret-body' }));
  for (let i = 0; i < 70; i++) await r.probeLane('nexitally', new AbortController().signal);
  const output = JSON.stringify(r.snapshot, null, 2);
  assert.ok(output.length < 26000); assert.ok(r.snapshot.probes.length > 10);
  assert.equal(output.includes('secret-body'), false); assert.equal(output.includes(r.token), false);
});
