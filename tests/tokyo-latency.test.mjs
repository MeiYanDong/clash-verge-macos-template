import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokyoPracticalRuntime } from '../src/tokyo-practical-runtime.mjs';
import { DEFAULT_PORTS, residenceName } from '../src/tokyo-practical-config.mjs';
import { selectedProbes } from '../src/tokyo-status-input.mjs';
function fixture(t, outcomes = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-latency-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const r = new TokyoPracticalRuntime({ settings: { uid: process.getuid(), ports: DEFAULT_PORTS }, directory, binary: '/bin/false' });
  r.child = { exitCode: null, signalCode: null }; r.selectedLane = 'nexitally';
  const probes = [], writes = []; let chosen = residenceName('nexitally');
  r.probeLane = async (lane, signal) => {
    probes.push(lane); const [outcome, ms] = outcomes[lane] || ['VERIFIED', lane === 'nexitally' ? 3500 : 1000];
    r.recordProbe(lane, outcome, performance.now() - ms); return signal.aborted ? 'UNAVAILABLE' : outcome;
  };
  r.api = async (route, options = {}) => {
    if (options.method) writes.push({ route, method: options.method });
    if (options.method === 'PUT') chosen = JSON.parse(options.body).name;
    return { now: chosen };
  };
  return { r, probes, writes, signal: new AbortController().signal };
}
test('two consecutive slow complete checks switch to a substantially faster verified residence chain', async t => {
  const { r, probes, signal } = fixture(t);
  assert.equal(await r.checkExit(signal), true); assert.equal(r.selectedLane, 'nexitally');
  assert.equal(await r.checkExit(signal), true); assert.equal(r.selectedLane, 'bygcloud');
  assert.deepEqual(probes, ['nexitally', 'nexitally', 'bygcloud']);
  assert.equal(r.lastSwitch.reason, 'LATENCY_DEGRADED'); assert.equal(r.switches, 1);
});
test('normal sample resets slow streak; occasional jitter does not switch', async t => {
  const outcomes = { nexitally: ['VERIFIED', 3500] }, { r, probes, signal } = fixture(t, outcomes);
  await r.checkExit(signal); outcomes.nexitally[1] = 1000; await r.checkExit(signal);
  outcomes.nexitally[1] = 3500; await r.checkExit(signal);
  assert.equal(r.slowStreak, 1); assert.equal(probes.length, 3); assert.equal(r.switches, 0);
});
for (const [name, alternate] of [['unavailable', ['UNAVAILABLE', 5000]], ['slower', ['VERIFIED', 4500]],
  ['insufficient absolute gain', ['VERIFIED', 2900]], ['insufficient proportional gain', ['VERIFIED', 2700]]]) {
  test(`slow chain is retained when alternate is ${name}; candidate checks are rate limited`, async t => {
    const { r, signal, probes } = fixture(t, { bygcloud: alternate });
    await r.checkExit(signal); await r.checkExit(signal); await r.checkExit(signal);
    assert.equal(r.selectedLane, 'nexitally'); assert.equal(r.switches, 0);
    assert.equal(probes.filter(l => l === 'bygcloud').length, 1);
  });
}
test('candidate identity mismatch is fatal even if active residence was verified', async t => {
  const { r, signal, writes } = fixture(t, { bygcloud: ['EXIT_MISMATCH', 1000] });
  await r.checkExit(signal); writes.length = 0;
  assert.equal(await r.checkExit(signal), false); assert.equal(writes.length, 0);
});
test('hard failure ignores latency cooldown and retains full alternate verification', async t => {
  const { r, signal } = fixture(t, { nexitally: ['UNAVAILABLE', 5000] });
  r.lastSwitchTick = performance.now(); r.lastLatencyAttempt = performance.now();
  assert.equal(await r.checkExit(signal), true); assert.equal(r.selectedLane, 'bygcloud');
  assert.equal(r.lastSwitch.reason, 'ACTIVE_CHAIN_FAILED');
});
test('post-switch cooldown prevents latency flapping', async t => {
  const { r, signal, probes } = fixture(t);
  r.lastSwitchTick = performance.now();
  await r.checkExit(signal); await r.checkExit(signal); await r.checkExit(signal);
  assert.deepEqual(probes, ['nexitally', 'nexitally', 'nexitally']);
});
test('abort while testing faster candidate cannot select or clear connections', async t => {
  const { r, writes } = fixture(t), controller = new AbortController();
  await r.checkExit(controller.signal); writes.length = 0;
  const probe = r.probeLane;
  r.probeLane = async (lane, signal) => { const out = await probe(lane, signal); if (lane === 'bygcloud') controller.abort(); return out; };
  assert.equal(await r.checkExit(controller.signal), false); assert.equal(writes.length, 0);
});
test('status view uses selected chain actual timestamp, not a newer standby test', () => {
  const active = { lane: 'nexitally', at: '2026-10-07T13:00:00Z', outcome: 'VERIFIED' };
  const other = { lane: 'bygcloud', at: '2026-10-07T13:00:04Z', outcome: 'UNAVAILABLE', failure: { transportCode: 28 } };
  assert.deepEqual(selectedProbes({ selectedLane: 'nexitally', probes: [active, other] }), [active]);
  assert.deepEqual(selectedProbes({ selectedLane: null, probes: [active] }), []);
});
test('diagnostic history is bounded and no credentials enter failure data', t => {
  const { r } = fixture(t);
  for (let i = 0; i < 80; i++) r.recordProbe('bygcloud', 'UNAVAILABLE', performance.now(),
    { endpoint: 'ipify', transportCode: 28, httpStatus: 0 });
  assert.equal(r.snapshot.probes.length, 60);
  assert.deepEqual(r.snapshot.probes.at(-1).failure, { endpoint: 'ipify', transportCode: 28, httpStatus: 0 });
});
