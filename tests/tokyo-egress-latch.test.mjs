import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TokyoEgressLatch } from '../src/tokyo-egress-latch.mjs';

async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve)); return p;
}
async function fixture(overrides = {}) {
  const connected = new Set();
  const echo = net.createServer(s => { connected.add(s); s.on('data', b => s.write(b)); s.on('error', () => {}); s.on('close', () => connected.delete(s)); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const port = await freePort(); let healthy = true;
  const latch = new TokyoEgressLatch({ gatePort: port, upstreamPort: echo.address().port,
    intervalMs: 25, checkTimeoutMs: 80, startCore: async () => {}, stopCore: async () => true,
    checkExit: async () => healthy, ...overrides });
  await latch.listen();
  return { latch, port, fail: () => { healthy = false; }, recover: () => { healthy = true; },
    async cleanup() { await latch.close(); for (const s of connected) s.destroy(); await new Promise(r => echo.close(r)); } };
}
async function connect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await delay(5); assert.ok(fn()); }

test('starts locked and does not dial or probe until explicit manual arm', async () => {
  const f = await fixture();
  try {
    const client = await connect(f.port); await until(() => client.destroyed);
    await delay(70);
    assert.equal(f.latch.snapshot.state, 'LOCKED');
    assert.equal(f.latch.snapshot.coreStarts, 0); assert.equal(f.latch.snapshot.exitChecks, 0);
    assert.equal(f.latch.snapshot.upstreamDials, 0);
  } finally { await f.cleanup(); }
});
test('health failure destroys existing streams, rejects new clients, and never auto-recovers', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.latch.armManually(), true);
    const client = await connect(f.port);
    const data = new Promise(r => client.once('data', r)); client.write('held-stream');
    assert.equal((await data).toString(), 'held-stream');
    f.fail(); await until(() => f.latch.snapshot.state === 'LOCKED');
    await until(() => client.destroyed);
    const before = f.latch.snapshot;
    const denied = await connect(f.port); await until(() => denied.destroyed);
    f.recover(); await delay(90);
    const after = f.latch.snapshot;
    assert.equal(after.state, 'LOCKED'); assert.equal(after.coreStarts, before.coreStarts);
    assert.equal(after.exitChecks, before.exitChecks); assert.equal(after.upstreamDials, before.upstreamDials);
    assert.equal(after.healthTimerScheduled, false); assert.equal(after.openSockets, 0);
    assert.equal(await f.latch.armManually(), true);
    assert.equal(f.latch.snapshot.coreStarts, 2);
  } finally { await f.cleanup(); }
});
test('missing or failed initial exit check never opens the gate', async () => {
  for (const checkExit of [async () => false, async () => { throw Error('private failure'); }]) {
    const f = await fixture({ checkExit });
    try {
      assert.equal(await f.latch.armManually(), false);
      assert.equal(f.latch.snapshot.state, 'LOCKED');
      assert.equal(f.latch.snapshot.upstreamDials, 0);
    } finally { await f.cleanup(); }
  }
});
test('timed-out check aborts, locks, and cannot be reopened by a late success', async () => {
  let resolveCheck; let signal;
  const f = await fixture({ checkExit: s => { signal = s; return new Promise(resolve => { resolveCheck = resolve; }); } });
  try {
    const arm = f.latch.armManually();
    assert.equal(await arm, false); assert.equal(signal.aborted, true);
    resolveCheck(true); await delay(30);
    assert.equal(f.latch.snapshot.state, 'LOCKED');
  } finally { await f.cleanup(); }
});
test('stop failure remains fail-closed and cannot be manually armed again', async () => {
  const f = await fixture({ stopCore: async () => false });
  try {
    assert.equal(await f.latch.armManually(), true);
    assert.equal(await f.latch.trip(), 'STOP_UNCONFIRMED');
    await assert.rejects(f.latch.armManually(), /LATCH_ARM_STATE/);
    const s = await connect(f.port); await until(() => s.destroyed);
    assert.equal(f.latch.snapshot.healthTimerScheduled, false);
  } finally { await f.cleanup(); }
});
test('concurrent locks stop the core once and cannot permit a stale verification', async () => {
  let finish; const f = await fixture({ checkExit: () => new Promise(r => { finish = r; }) });
  try {
    const arming = f.latch.armManually(); await until(() => !!finish);
    await Promise.all([f.latch.trip(), f.latch.trip()]); finish(true);
    assert.equal(await arming, false); assert.equal(f.latch.snapshot.state, 'LOCKED');
    assert.equal(f.latch.snapshot.coreStops, 1);
  } finally { await f.cleanup(); }
});
test('a core starting after a lock is stopped again before the latch becomes rearmable', async () => {
  let finishStart, alive = false, startSignal;
  const f = await fixture({
    startCore: signal => { startSignal = signal; return new Promise(resolve => { finishStart = () => { alive = true; resolve(); }; }); },
    stopCore: async () => { alive = false; return true; }
  });
  try {
    const arming = f.latch.armManually(); await until(() => !!finishStart);
    const locking = f.latch.trip(); await delay(5);
    assert.equal(startSignal.aborted, true); finishStart();
    assert.equal(await arming, false); assert.equal(await locking, 'LOCKED');
    assert.equal(alive, false); assert.equal(f.latch.snapshot.coreStops, 2);
  } finally { await f.cleanup(); }
});
test('an unresponsive stop does not hang forever or report the core stopped', async () => {
  const f = await fixture({ stopCore: () => new Promise(() => {}) });
  try {
    assert.equal(await f.latch.armManually(), true);
    assert.equal(await f.latch.trip(), 'STOP_UNCONFIRMED');
    await assert.rejects(f.latch.armManually(), /LATCH_ARM_STATE/);
  } finally { await f.cleanup(); }
});
