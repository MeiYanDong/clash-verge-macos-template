import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePracticalConfig, DEFAULT_PORTS, LANES, residenceName, TOKYO_GROUP } from '../src/tokyo-practical-config.mjs';
import { TokyoPracticalRuntime, inspectExit, privateJson, writePrivateJson } from '../src/tokyo-practical-runtime.mjs';

export function settingsFixture() {
  return { uid: process.getuid(), ports: { ...DEFAULT_PORTS },
    intake: { protocol: 'socks5', server: 'residential.example', port: 1080,
      authentication: { method: 'username-password', username: 'fixture', password: 'fixture' },
      expectedExit: { country: 'JP', ipv4: '192.0.2.10' } },
    transits: {
      bygcloud: { name: '🇯🇵 V日本 01', type: 'vless', server: 'b.example', port: 443, uuid: 'fixture' },
      nexitally: { name: '🇯🇵 Japan 01', type: 'anytls', server: 'n.example', port: 443, password: 'fixture' }
    }
  };
}
const config = input => makePracticalConfig({ ...input, interfaceName: 'en0', token: 'a'.repeat(48) });
test('both candidates end in the identical residential and have no alternative egress', () => {
  const c = config(settingsFixture());
  assert.deepEqual(c['proxy-groups'][0].proxies, LANES.map(residenceName));
  assert.equal(c['proxy-groups'][0]['empty-fallback'], 'REJECT');
  assert.equal(c['proxy-groups'][0].type, 'select'); assert.equal(c['proxy-groups'][0].interval, 0);
  const exits = c.proxies.filter(p => p.type === 'socks5');
  assert.equal(exits.length, 2);
  for (const key of ['server', 'port', 'username', 'password']) assert.equal(exits[0][key], exits[1][key]);
  assert.notEqual(exits[0]['dialer-proxy'], exits[1]['dialer-proxy']);
  assert.deepEqual(c.rules, ['NETWORK,udp,REJECT', `MATCH,${TOKYO_GROUP}`]);
  assert.equal(JSON.stringify(c).includes('DIRECT'), false);
});
test('loopback-only explicit service leaves TUN and system proxy alone', () => {
  const c = config(settingsFixture());
  assert.equal(c.tun.enable, false); assert.equal(c.dns.listen, '127.0.0.1:0'); assert.equal(c.ipv6, false);
  assert.equal(c['bind-address'], '127.0.0.1'); assert.equal(c['allow-lan'], false);
  for (const listener of c.listeners) {
    assert.equal(listener.listen, '127.0.0.1'); assert.equal(listener.users.length, 1);
    assert.ok(LANES.map(residenceName).includes(listener.proxy));
  }
});
test('bootstrap DNS does not consume system fake IPs and destination DNS uses the residential chain', () => {
  const c = config(settingsFixture());
  assert.equal(c.dns.enable, true); assert.equal(c.dns['enhanced-mode'], 'redir-host');
  assert.equal(c.dns['use-system-hosts'], false);
  assert.ok(c.dns['proxy-server-nameserver'].every(x => x.startsWith('https://') && x.endsWith('#en0')));
  assert.deepEqual(c.dns.nameserver, [`https://1.1.1.1/dns-query#${TOKYO_GROUP}`]);
});
test('rejects wrong regions, inherited chains, missing providers and duplicate ports', () => {
  for (const mutate of [s => { delete s.transits.bygcloud; },
    s => { s.transits.bygcloud.type = 'direct'; },
    s => { s.transits.bygcloud['dialer-proxy'] = 'DIRECT'; },
    s => { s.transits.nexitally['interface-name'] = 'en1'; },
    s => { s.ports.bygcloud = s.ports.gate; },
    s => { s.intake.expectedExit.country = 'US'; }]) {
    const s = settingsFixture(); mutate(s); assert.throws(() => config(s), /TOKYO_INVALID/);
  }
});
test('does not mutate source provider credentials or settings', () => {
  const s = settingsFixture(), before = structuredClone(s); config(s); assert.deepEqual(s, before);
});
test('exit identity mismatch cannot count as a usable but slower route', () => {
  const ip = '192.0.2.10';
  assert.equal(inspectExit({ code: 0, status: 200, body: ip }, ip), 'VERIFIED');
  assert.equal(inspectExit({ code: 0, status: 200, body: '192.0.2.11' }, ip), 'EXIT_MISMATCH');
  assert.equal(inspectExit({ code: 0, status: 200, body: `ip=${ip}\nloc=US` }, ip, true), 'EXIT_MISMATCH');
  assert.equal(inspectExit({ code: 0, status: 200, body: '<html>error</html>' }, ip), 'UNAVAILABLE');
  assert.equal(inspectExit({ code: 35, status: 0, body: '' }, ip), 'UNAVAILABLE');
});
function runtimeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-practical-unit-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const r = new TokyoPracticalRuntime({ settings: settingsFixture(), directory, binary: '/bin/false' });
  r.child = { exitCode: null, signalCode: null }; let selected; const calls = [];
  r.api = async (route, options = {}) => {
    calls.push({ route, method: options.method });
    if (options.method === 'PUT') selected = JSON.parse(options.body).name;
    return { now: selected };
  };
  return { r, calls, directory };
}
test('failed primary switches only after full alternate-chain verification', async t => {
  const { r, calls } = runtimeFixture(t); r.selectedLane = 'bygcloud'; const probes = [];
  r.probeLane = async lane => { probes.push(lane); return lane === 'bygcloud' ? 'UNAVAILABLE' : 'VERIFIED'; };
  assert.equal(await r.checkExit(new AbortController().signal), true);
  assert.deepEqual(probes, LANES); assert.equal(r.selectedLane, 'nexitally'); assert.equal(r.switches, 1);
  assert.ok(calls.some(c => c.route === '/connections' && c.method === 'DELETE'));
});
test('residential failure on both chains returns false without a third choice', async t => {
  const { r, calls } = runtimeFixture(t); const probes = [];
  r.probeLane = async lane => { probes.push(lane); return 'UNAVAILABLE'; };
  assert.equal(await r.checkExit(new AbortController().signal), false);
  assert.deepEqual(probes, LANES); assert.equal(calls.length, 0);
});
test('unexpected exit stops verification immediately instead of searching for another exit', async t => {
  const { r, calls } = runtimeFixture(t); let checks = 0;
  r.probeLane = async () => { checks++; return 'EXIT_MISMATCH'; };
  assert.equal(await r.checkExit(new AbortController().signal), false); assert.equal(checks, 1);
  assert.equal(calls.length, 0);
});
test('a cancelled health check cannot select a new route', async t => {
  const { r, calls } = runtimeFixture(t); const abort = new AbortController();
  r.probeLane = async () => { abort.abort(); return 'VERIFIED'; };
  assert.equal(await r.checkExit(abort.signal), false); assert.equal(calls.length, 0);
});
test('private file writes are owner-only and symlinks are rejected', t => {
  const { directory } = runtimeFixture(t); const file = path.join(directory, 'settings.json');
  writePrivateJson(file, { fixture: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.deepEqual(privateJson(file), { fixture: true });
  const link = path.join(directory, 'link'); fs.symlinkSync(file, link);
  assert.throws(() => privateJson(link), /UNSAFE_PRIVATE_FILE/);
});
