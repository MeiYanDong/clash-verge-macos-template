import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TokyoPracticalRuntime, TokyoControllerError } from '../src/tokyo-practical-runtime.mjs';
import { TokyoEgressLatch } from '../src/tokyo-egress-latch.mjs';
import { DEFAULT_PORTS, residenceName } from '../src/tokyo-practical-config.mjs';
function fixture(t, controllerFetch) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-controller-test-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const r = new TokyoPracticalRuntime({ directory, binary: '/bin/false', controllerFetch,
    settings: { uid: process.getuid(), ports: DEFAULT_PORTS, intake: { expectedExit: { ipv4: '192.0.2.10' } } },
    request: async ({ url }) => ({ code: 0, status: 200,
      body: url.includes('ipify') ? '192.0.2.10' : 'ip=192.0.2.10\nloc=JP' }) });
  r.child = { exitCode: null, signalCode: null }; r.selectedLane = 'nexitally'; return r;
}
const response = (now = residenceName('nexitally')) => Response.json({ now });
test('stable selected lane is read back without redundant PUT or connection DELETE', async t => {
  const methods = [], r = fixture(t, async (url, opts) => { methods.push(opts.method || 'GET'); return response(); });
  assert.equal(await r.checkExit(new AbortController().signal), true);
  assert.deepEqual(methods, ['GET']); assert.equal(r.lastCheckFailure, null);
  assert.equal(r.snapshot.probes.at(-1).endpoints.length, 2);
});
for (const [name, fail] of [
  ['timeout', async () => { throw new DOMException('sensitive-timeout', 'TimeoutError'); }],
  ['reset', async () => { throw new TypeError('secret', { cause: { code: 'ECONNRESET' } }); }],
  ['refused', async () => { throw Object.assign(Error('secret'), { code: 'ECONNREFUSED' }); }],
  ['HTTP 503', async () => new Response('secret', { status: 503 })],
  ['body reset', async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(Error('secret'), { code: 'UND_ERR_SOCKET' }); } })]
]) test(`verified exit plus controller ${name} closes with typed recoverable failure`, async t => {
  const r = fixture(t, fail); assert.equal(await r.checkExit(new AbortController().signal), false);
  assert.equal(r.lastCheckFailure, 'CONTROLLER_UNAVAILABLE');
  assert.equal(r.snapshot.probes.at(-1).outcome, 'VERIFIED');
  assert.equal(r.snapshot.checkDiagnostics.at(-1).stage, 'READ_SELECTION');
  assert.ok(!JSON.stringify(r.snapshot).includes('secret'));
});
for (const [name, fail] of [
  ['unauthorized', async () => new Response('token', { status: 401 })],
  ['forbidden', async () => new Response('token', { status: 403 })],
  ['missing selector', async () => new Response('body', { status: 404 })],
  ['bad JSON', async () => new Response('secret', { status: 200 })],
  ['selection mismatch', async () => response('DIRECT')],
  ['unclassified fetch', async () => { throw new TypeError('secret'); }]
]) test(`controller ${name} stays fatal, never a retryable transport failure`, async t => {
  const r = fixture(t, fail); assert.equal(await r.checkExit(new AbortController().signal), false);
  assert.equal(r.lastCheckFailure, 'CHECK_ERROR');
  assert.ok(r.snapshot.checkDiagnostics.length); assert.ok(!JSON.stringify(r.snapshot).includes('secret'));
});
test('caller cancellation reaches pending controller I/O and cannot enable a retry', async t => {
  let seen; const abort = new AbortController();
  const r = fixture(t, async (url, options) => {
    seen = options.signal; abort.abort(); throw new DOMException('secret', 'AbortError');
  });
  assert.equal(await r.checkExit(abort.signal), false); assert.equal(seen.aborted, true);
  assert.equal(r.lastCheckFailure, 'CHECK_ERROR'); assert.equal(r.snapshot.checkDiagnostics.at(-1).code, 'ABORTED');
});
test('diagnostic history is bounded and unknown probe exceptions are not transport retries', async t => {
  const r = fixture(t, async () => response());
  r.request = async () => { throw Error('private-token-or-endpoint'); };
  for (let i = 0; i < 12; i++) assert.equal(await r.checkExit(new AbortController().signal), false);
  assert.equal(r.snapshot.checkDiagnostics.length, 8);
  assert.equal(r.snapshot.checkDiagnostics.at(-1).stage, 'PROBE_EXIT');
  assert.equal(r.lastCheckFailure, 'CHECK_ERROR'); assert.ok(!JSON.stringify(r.snapshot).includes('private-token'));
});
test('switch writes selector, confirms selection and closes old streams in order', async t => {
  const calls = []; let selected;
  const r = fixture(t, async (url, options) => {
    calls.push(options.method || 'GET');
    if (options.method === 'PUT') { selected = JSON.parse(options.body).name; return new Response(null, { status: 204 }); }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return response(selected);
  });
  assert.equal(await r.selectVerified('bygcloud', new AbortController().signal, 'ACTIVE_CHAIN_FAILED'), true);
  assert.deepEqual(calls, ['PUT', 'GET', 'DELETE']); assert.equal(r.selectedLane, 'bygcloud');
});
test('typed controller failure restarts behind closed gate, requiring two fresh full exit checks', async t => {
  const r = fixture(t, async () => response()); let broken = false, checks = 0, release;
  r.controllerFetch = async () => {
    if (broken) throw Object.assign(Error('secret'), { code: 'ECONNRESET' });
    return response();
  };
  const sockets = new Set(), echo = net.createServer(c => { sockets.add(c); c.on('error', () => {}); c.pipe(c); c.on('close', () => sockets.delete(c)); });
  const temp = net.createServer(); await new Promise(done => temp.listen(0, '127.0.0.1', done));
  const gatePort = temp.address().port; await new Promise(done => temp.close(done));
  await new Promise(done => echo.listen(0, '127.0.0.1', done));
  const latch = new TokyoEgressLatch({ gatePort, upstreamPort: echo.address().port, intervalMs: 25,
    checkTimeoutMs: 500, recovery: { enabled: true, delaysMs: [80], confirmations: 2, confirmationGapMs: 30 },
    startCore: async () => { r.child = { exitCode: null, signalCode: null }; },
    stopCore: async () => { r.child.exitCode = 0; return true; }, checkExit: async signal => {
      if (latch.snapshot.recovery.attempts && ++checks === 2) await new Promise(done => { release = done; });
      return { healthy: await r.checkExit(signal), failure: r.lastCheckFailure };
    } });
  const until = async fn => { for (let i = 0; i < 300 && !fn(); i++) await delay(5); assert.ok(fn()); };
  t.after(async () => { release?.(); await latch.close(); for (const c of sockets) c.destroy(); await new Promise(done => echo.close(done)); });
  await latch.listen(); assert.equal(await latch.armManually(), true);
  const held = net.connect(gatePort, '127.0.0.1'); held.on('error', () => {});
  await new Promise(done => held.once('connect', done));
  const echoed = new Promise(done => held.once('data', done)); held.write('x'); await echoed;
  broken = true; await until(() => latch.snapshot.state === 'LOCKED'); await until(() => held.destroyed);
  assert.equal(latch.snapshot.lastTrip.failure, 'CONTROLLER_UNAVAILABLE');
  assert.equal(latch.snapshot.recovery.timerScheduled, true); broken = false;
  await until(() => !!release); assert.equal(latch.snapshot.state, 'VERIFYING');
  const before = latch.snapshot.upstreamDials, denied = net.connect(gatePort, '127.0.0.1'); denied.on('error', () => {});
  await until(() => denied.destroyed); assert.equal(latch.snapshot.upstreamDials, before);
  release(); await until(() => latch.snapshot.state === 'READY');
  assert.equal(checks, 2); assert.ok(latch.snapshot.recovery.lastRecoveredAt);
});
test('only API-classified failures receive transient status, not generic exceptions with similar text', async t => {
  const r = fixture(t, async () => response());
  r.api = async () => { throw Object.assign(Error('TOKYO_CONTROLLER_FAILURE'), { transient: true }); };
  assert.equal(await r.checkExit(new AbortController().signal), false); assert.equal(r.lastCheckFailure, 'CHECK_ERROR');
  assert.ok(new TokyoControllerError('TIMEOUT', true) instanceof Error);
});
