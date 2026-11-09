import { preflight } from './rendered-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { classifyMain, rulesDigest } = preflight;
import { StartupIntent, StartupPolicy, durableJson, readinessRecord } from '../src/tokyo-startup-policy.mjs';
import { TokyoPracticalRuntime } from '../src/tokyo-practical-runtime.mjs';

const gate = '🗼 Claude 东京专线（受控入口）';
const good = () => ({ config: { mode: 'rule', tun: { enable: true } },
  rules: [{ type: 'DomainSuffix', payload: 'claude.ai', proxy: 'Claude · 东京静态住宅' }],
  proxies: { 'Claude · 东京静态住宅': { type: 'Selector', now: gate, all: [gate] }, [gate]: { type: 'Http' } },
  endpoint: { name: gate, type: 'http', server: '127.0.0.1', port: 44127 } });
const hash = rulesDigest(good().rules);
async function until(fn) {
  for (let i = 0; i < 500; i++) { if (fn()) return; await delay(5); }
  assert.ok(fn(), 'condition timed out');
}
async function ports() {
  const result = {}, servers = [];
  for (const name of ['gate', 'upstream', 'controller', 'bygcloud', 'nexitally']) {
    const s = net.createServer(); servers.push(s);
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); result[name] = s.address().port;
  }
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); return result;
}
async function fixture(t, existing) {
  const dir = existing || fs.mkdtempSync('/private/tmp/tokyo-tun-resume-unit-');
  if (!existing) { fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }
  const file = path.join(dir, 'intent.json');
  if (!existing) durableJson(file, { version: 1, allowed: true, reason: 'USER_ENABLED' });
  const intent = new StartupIntent(file), p = await ports();
  let input = good(), healthy = true, failure = 'UNAVAILABLE', checks = 0, checking;
  let startup;
  const runtime = new TokyoPracticalRuntime({ directory: dir, binary: '/bin/false',
    settings: { uid: process.getuid(), ports: p }, intervalMs: 25, checkTimeoutMs: 250,
    recovery: { enabled: true, delaysMs: [40, 60, 80], confirmations: 2, confirmationGapMs: 25 },
    readinessCheck: () => startup.readiness(), onTrip: (r, m) => intent.trip(r, m), onReady: () => intent.ready() });
  runtime.startCore = async () => {}; runtime.stopCore = async () => true;
  runtime.checkExit = async () => { checks++; if (checking) await checking(); runtime.lastCheckFailure = healthy ? null : failure; return healthy; };
  startup = new StartupPolicy({ intent, latch: runtime.latch, rulesHash: hash,
    readReadiness: () => ({ version: 1, at: new Date().toISOString(), pid: process.pid,
      challenge: startup.challenge, rulesHash: hash, status: classifyMain(input, hash) }) });
  await runtime.listen(); t.after(() => runtime.close());
  return { dir, file, intent, runtime, startup, p, set: v => { input = v; }, get checks() { return checks; },
    health: (v, f = 'UNAVAILABLE') => { healthy = v; failure = f; }, hold: fn => { checking = fn; } };
}
async function denied(f) {
  const before = f.runtime.latch.snapshot.upstreamDials;
  const socket = net.connect(f.p.gate, '127.0.0.1'); socket.on('error', () => {});
  await until(() => socket.destroyed); assert.equal(f.runtime.latch.snapshot.upstreamDials, before);
}

test('disabled TUN is closed/retryable; unknown TUN or proxy mode remains a safety mismatch', () => {
  const off = good(); off.config.tun.enable = false;
  assert.equal(classifyMain(off, hash), 'WAITING');
  for (const tun of [{}, { enable: 'false' }, null])
    assert.equal(classifyMain({ ...off, config: { mode: 'rule', tun } }, hash), 'MISMATCH');
  assert.equal(classifyMain({ ...off, config: { mode: 'direct', tun: { enable: false } } }, hash), 'MISMATCH');
});
test('disabled TUN and missing controller fields cannot mask observable rule or route changes', () => {
  for (const mutate of [c => c.rules.reverse().push({ type: 'Match', proxy: 'DIRECT' }),
    c => c.proxies['Claude · 东京静态住宅'].all.push('DIRECT'), c => c.endpoint.port = 7897]) {
    const c = good(); c.config.tun.enable = false; mutate(c);
    assert.equal(classifyMain(c, hash), 'MISMATCH'); c.config = null;
    assert.equal(classifyMain(c, hash), 'MISMATCH');
  }
  assert.equal(classifyMain({ config: null, rules: undefined, proxies: null, endpoint: good().endpoint }, hash), 'WAITING');
});
test('WAITING attestations still require the exact baseline and fresh instance binding', () => {
  const ctx = { challenge: 'a'.repeat(32), pid: 5, rulesHash: hash, now: Date.now() };
  const r = { version: 1, challenge: ctx.challenge, pid: 5, at: new Date(ctx.now).toISOString(), status: 'WAITING', rulesHash: hash };
  assert.equal(readinessRecord(r, ctx), 'WAITING');
  assert.equal(readinessRecord({ ...r, rulesHash: 'f'.repeat(64) }, ctx), 'MISMATCH');
  assert.equal(readinessRecord({ ...r, status: 'VERIFIED', challenge: 'old' }, ctx), 'WAITING');
  assert.equal(readinessRecord({ ...r, status: 'VERIFIED', at: new Date(ctx.now - 15001).toISOString() }, ctx), 'WAITING');
});
for (const outage of ['TUN_OFF', 'CLASH_UNAVAILABLE']) test(`${outage} closes clients, then restores only after two residential confirmations`, async t => {
  const f = await fixture(t); await f.startup.step(); assert.equal(f.runtime.latch.snapshot.state, 'READY');
  const off = good(); if (outage === 'TUN_OFF') off.config.tun.enable = false;
  else { off.config = null; off.rules = undefined; off.proxies = null; }
  f.set(off); await until(() => f.runtime.latch.snapshot.state === 'LOCKED'); await denied(f);
  assert.equal(f.intent.state.allowed, true); assert.equal(f.runtime.latch.snapshot.recovery.wanted, true);
  const checks = f.checks; await until(() => f.runtime.latch.snapshot.recovery.attempts >= 1);
  assert.equal(f.checks, checks); // Not even the residential check runs with TUN unavailable.
  let release, count = 0; f.hold(() => ++count === 2 ? new Promise(r => { release = r; }) : undefined);
  f.set(good()); await until(() => !!release); await denied(f);
  assert.equal(f.runtime.latch.snapshot.state, 'VERIFYING'); release();
  await until(() => f.runtime.latch.snapshot.state === 'READY'); assert.ok(f.checks >= checks + 2);
});
test('TUN off before activation waits without dialing and survives normal shutdown', async t => {
  const f = await fixture(t), off = good(); off.config.tun.enable = false; f.set(off);
  await f.startup.step(); await denied(f); assert.equal(f.runtime.latch.snapshot.coreStarts, 0);
  assert.equal(new StartupIntent(f.file).state.allowed, false); // A crash is still denied.
  f.startup.stop(); await f.runtime.close(); assert.equal(new StartupIntent(f.file).state.allowed, true);
  const next = await fixture(t, f.dir); await next.startup.step();
  assert.equal(next.runtime.latch.snapshot.state, 'READY'); assert.equal(next.checks, 2);
});
test('normal restart after initial transient verification failure retains permission but rechecks twice', async t => {
  const f = await fixture(t); f.health(false); await f.startup.step(); await denied(f);
  assert.equal(f.intent.state.allowed, true); assert.equal(new StartupIntent(f.file).state.allowed, false);
  f.startup.stop(); await f.runtime.close(); assert.equal(new StartupIntent(f.file).state.allowed, true);
  const next = await fixture(t, f.dir); await next.startup.step();
  assert.equal(next.runtime.latch.snapshot.state, 'READY'); assert.equal(next.checks, 2);
});
test('normal restart while TUN is paused resumes through fresh startup verification', async t => {
  const f = await fixture(t); await f.startup.step(); const off = good(); off.config.tun.enable = false; f.set(off);
  await until(() => f.runtime.latch.snapshot.state === 'LOCKED'); f.startup.stop(); await f.runtime.close();
  const next = await fixture(t, f.dir); await next.startup.step();
  assert.equal(next.runtime.latch.snapshot.state, 'READY'); assert.equal(next.checks, 2);
});
for (const reason of ['MANUAL_LOCK', 'RULE_MISMATCH', 'EXIT_MISMATCH']) test(`${reason} remains inhibited through TUN restore and normal restart`, async t => {
  const f = await fixture(t); await f.startup.step(); const off = good(); off.config.tun.enable = false; f.set(off);
  await until(() => f.runtime.latch.snapshot.state === 'LOCKED');
  if (reason === 'MANUAL_LOCK') await f.runtime.latch.trip('MANUAL_LOCK');
  else if (reason === 'RULE_MISMATCH') { off.rules.push({ type: 'Match', proxy: 'DIRECT' }); f.set(off); }
  else { f.health(false, 'EXIT_MISMATCH'); f.set(good()); }
  await until(() => f.intent.state.allowed === false);
  f.set(good()); f.health(true); await delay(180); await f.startup.step(); await denied(f);
  assert.equal(f.runtime.latch.snapshot.state, 'LOCKED'); assert.equal(f.runtime.latch.snapshot.recovery.wanted, false);
  f.startup.stop(); await f.runtime.close(); const next = await fixture(t, f.dir); await next.startup.step(); await denied(next);
  assert.equal(next.runtime.latch.snapshot.coreStarts, 0); assert.equal(next.intent.state.allowed, false);
});
