import { auth } from './rendered-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { validateRequest, classifyChrome, handleRequest, authorizeState, CHROME, DATA, PROXY } = auth;
const sessionID = '12345678-1234-1234-1234-123456789abc';
const open = (url = 'https://claude.ai/login/app-google-auth?state=not-a-real-token') => ({ op: 'open', sessionID, url });
test('HTTPS authorization URL is preserved byte for byte and is not reconstructed', () => {
  const r = open('https://claude.ai/login/app-google-auth?x=a%2Fb%2Bc&x=d#fragment');
  assert.equal(validateRequest(r).url, r.url); assert.deepEqual(validateRequest({ op: 'prepare' }), { op: 'prepare' });
});
test('ambiguous requests, non-HTTPS, file/script/internal URLs and literal credentials are refused', () => {
  for (const url of ['http://claude.ai/login', 'javascript:alert(1)', 'file:///tmp/token', 'claude://auth?x=secret', 'https://u:p@example.invalid', 'https://127.0.0.1/', 'https://[::1]/', 'https://foo.local/', 'https://foo.localhost/', 'https://claude.ai:8443/', 'https://claude.ai/\nfoo']) assert.throws(() => validateRequest(open(url)));
  for (const r of [null, [], { op: 'prepare', url: 'x' }, { ...open(), extra: true }, { op: 'open', url: 'https://claude.ai' }]) assert.throws(() => validateRequest(r));
});
const command = `${CHROME} --user-data-dir=${DATA} --proxy-server=${PROXY} --proxy-bypass-list=localhost;127.0.0.1;[::1] --disable-quic --disable-sync --new-window https://example.com/`;
test('running Tokyo profile must have exactly the expected proxy flags', () => {
  assert.equal(classifyChrome(command), 'tokyo');
  assert.equal(classifyChrome(CHROME + ' --profile-directory=Default'), 'other');
  assert.equal(classifyChrome(command.replace(DATA, DATA + '-other')), 'other');
  for (const c of [command.replace(PROXY, 'direct://'), command + ' --proxy-server=http://127.0.0.1:7897', command + ' --no-proxy-server', command.replace('--disable-quic ', ''), command.replace('[::1]', '*')]) assert.equal(classifyChrome(c), 'unsafe');
});
function deps(change = {}) {
  const calls = [];
  return { calls, integrity: async () => calls.push('integrity'), existing: () => 123,
    probe: async () => [{ matched: true }, { matched: true }], browserProof: async () => 'http://127.0.0.1:1/diagnostic/',
    authorize: async () => calls.push('authorize'), open: async url => calls.push(url), ...change };
}
test('prepare never opens an authentication URL; normal open follows every check', async () => {
  const d = deps(); await handleRequest({ op: 'prepare' }, d); assert.deepEqual(d.calls, ['integrity']);
  d.calls.length = 0; const result = await handleRequest(open(), d);
  assert.deepEqual(d.calls, ['integrity', 'authorize', open().url]); assert(result.exitVerified); assert(!JSON.stringify(result).includes('token'));
});
test('each failure stops before any authentication navigation or fallback', async () => {
  for (const change of [
    { integrity: async () => { throw Error('tampered'); } },
    { existing: () => { throw Error('unsafe browser'); } },
    { existing: () => null },
    { probe: async () => [{ matched: true }, { matched: false }] },
    { probe: async () => [{ matched: true }] },
    { browserProof: async () => { throw Error('extension or browser exit failed'); } },
    { authorize: async () => { throw Error('finished during check'); } }
  ]) {
    const d = deps(change); await assert.rejects(handleRequest(open(), d)); assert(!d.calls.some(x => x.startsWith('https:')));
  }
});
test('ended, expired, corrupted and previous-session state cannot authorize a late URL', () => {
  const now = Date.now(), state = { phase: 'armed', sessionID, expiresAt: new Date(now + 10000).toISOString() };
  assert.doesNotThrow(() => authorizeState(state, sessionID, now));
  for (const s of [{ ...state, phase: 'ending' }, { ...state, phase: 'closed' }, { ...state, phase: 'paused' }, { ...state, sessionID: 'old' }, { ...state, expiresAt: 'bad' }, { ...state, expiresAt: new Date(now - 1).toISOString() }]) assert.throws(() => authorizeState(s, sessionID, now));
});
