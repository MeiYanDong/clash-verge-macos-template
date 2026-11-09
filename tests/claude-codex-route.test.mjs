import { route, tools } from './rendered-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { CODEX_BINARY, US_PROXY, US_GROUP, codexEnvironment, rewriteCodexCommand,
  assertUSPolicy, verifyUSRoute, traceThroughUS, rulesDigest } = route;
const { hookResult, routingEnvironment } = tools;


const root = '/Users/example/tool profile', wrapper = `${root}/bin/codex`;
const config = { mode: 'rule', 'mixed-port': 7897, tun: { enable: true } };
const proxies = { proxies: { [US_GROUP]: { now: 'US-RESIDENTIAL', all: ['US-RESIDENTIAL'] }, 'US-RESIDENTIAL': { type: 'Socks5' } } };
const rules = { rules: ['chatgpt.com', 'openai.com'].map(payload => ({ type: 'DomainSuffix', payload, proxy: US_GROUP })) };
test('Codex gets US proxy without mutating Claude environment or credential/profile variables', () => {
  const before = { ...routingEnvironment(root), PATH: `${root}/bin:/usr/bin:/bin`, HOME: '/Users/example', AWS_PROFILE: 'existing', TOKEN: 'fixture' };
  const original = structuredClone(before), after = codexEnvironment(root, before);
  assert.deepEqual(before, original);
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) assert.equal(after[key], US_PROXY);
  assert.equal(after.PATH, '/usr/bin:/bin'); assert.equal(after.GIT_SSH_COMMAND, undefined);
  for (const key of ['HOME','AWS_PROFILE','TOKEN']) assert.equal(after[key], before[key]);
  assert.equal(codexEnvironment(root, { GIT_SSH_COMMAND: 'custom-ssh' }).GIT_SSH_COMMAND, 'custom-ssh');
  assert.equal(before.HTTPS_PROXY, 'http://127.0.0.1:44127');
});
test('observed direct, quoted, timed and assigned executable calls redirect without modifying arguments', () => {
  for (const prefix of ['', 'time ', 'nohup ', 'exec ', 'command ']) {
    assert.equal(rewriteCodexCommand(`${prefix}${CODEX_BINARY} exec 'literal prompt'`, root), `${prefix}'${wrapper}' exec 'literal prompt'`);
  }
  for (const val of [CODEX_BINARY, `"${CODEX_BINARY}"`, `'${CODEX_BINARY}'`]) {
    assert.throws(() => rewriteCodexCommand(`C=${val}; "$C" exec "$(cat brief.md)"`, root), /USE_EXPLICIT_CODEX_WRAPPER/);
  }
  const cmd = `cd /work && "${CODEX_BINARY}" exec 'do not change ${CODEX_BINARY}'`;
  assert.equal(rewriteCodexCommand(cmd, root), `cd /work && '${wrapper}' exec 'do not change ${CODEX_BINARY}'`);
});
test('queries, comments, prompt strings, scripts and here-documents are not rewritten', () => {
  for (const cmd of [`echo '${CODEX_BINARY}'`, `pgrep -f '${CODEX_BINARY} exec'`, `cat ${CODEX_BINARY}`,
    `# ${CODEX_BINARY} exec\necho done`, `python3 - <<'PY'\nprint('${CODEX_BINARY}')\nPY`,
    './tools/codex_image.sh image.png prompt.txt']) assert.equal(rewriteCodexCommand(cmd, root), cmd);
});
test('hook is idempotent, keeps Tokyo prefix and preserves approval behavior', () => {
  const req = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `${CODEX_BINARY} exec hello`, timeout: 9000 } };
  const first = hookResult(req, root, route);
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(first.hookSpecificOutput.updatedInput.timeout, 9000);
  assert.match(first.hookSpecificOutput.updatedInput.command, /environment\.sh/);
  assert.match(first.hookSpecificOutput.updatedInput.command, /bin\/codex' exec hello$/);
  assert.deepEqual(hookResult({ ...req, tool_input: first.hookSpecificOutput.updatedInput }, root, route), first);
});
test('guard rejects global/direct routing, widened selectors and changed domain destinations', () => {
  assert.doesNotThrow(() => assertUSPolicy(config, proxies, rules, rulesDigest(rules.rules)));
  assert.throws(() => assertUSPolicy({ ...config, mode: 'global' }, proxies, rules, rulesDigest(rules.rules)), /POLICY_CHANGED/);
  const bad = structuredClone(proxies); bad.proxies[US_GROUP].all.push('DIRECT');
  assert.throws(() => assertUSPolicy(config, bad, rules, rulesDigest(rules.rules)), /POLICY_CHANGED/);
  assert.throws(() => assertUSPolicy(config, proxies, { rules: [] }, rulesDigest(rules.rules)), /RULES_CHANGED/);
});
test('exit mismatch and unavailable proxy stop before Codex, without any direct fallback', async () => {
  const policy = { binary: CODEX_BINARY, proxy: US_PROXY, expectedExitIP: '192.0.2.1', rulesHash: rulesDigest(rules.rules) };
  const api = async p => ({ '/configs':config, '/proxies':proxies, '/rules':rules })[p];
  await assert.rejects(verifyUSRoute(policy, {}, api, () => ({ ip:'192.0.2.2', country:'US' })), /EXIT_CHANGED/);
  await assert.rejects(verifyUSRoute(policy, {}, api, () => { throw Error('CLAUDE_CODEX_US_EXIT_UNAVAILABLE'); }), /UNAVAILABLE/);
  let calls = 0;
  assert.throws(() => traceThroughUS('https://chatgpt.com/cdn-cgi/trace', {}, (_bin,args) => {
    calls++; assert.deepEqual(args.slice(0,5), ['-q','--proxy',US_PROXY,'--noproxy','']); return { status:7, stdout:'' };
  }), /UNAVAILABLE/);
  assert.equal(calls, 1);
});

test('AST rewrite executes only the stub for conditions, env prefixes, redirects and substitutions', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex ast 中文 '));
  t.after(() => fs.rmSync(temp, { recursive:true, force:true }));
  fs.mkdirSync(path.join(temp,'bin'));
  fs.writeFileSync(path.join(temp,'bin/codex'), '#!/bin/sh\nprintf "WRAPPED:%s\\n" "$1"\n', {mode:0o700});
  for (const command of [
    `if ${CODEX_BINARY} sample; then :; fi`,
    `env -u HTTPS_PROXY ${CODEX_BINARY} sample`,
    `/usr/bin/env -u HTTPS_PROXY X=y ${CODEX_BINARY} sample`,
    `2>/dev/null ${CODEX_BINARY} sample`,
    `time -p ${CODEX_BINARY} sample`,
    `command -- ${CODEX_BINARY} sample`,
    `echo "$(${CODEX_BINARY} sample)"`,
    `for x in one; do ${CODEX_BINARY} sample; done`,
    `cat <<'EOF' >/dev/null\n${CODEX_BINARY}\nEOF\n${CODEX_BINARY} sample`,
  ]) {
    const rewritten = rewriteCodexCommand(command, temp);
    const run = spawnSync('/bin/bash', ['--noprofile','--norc','-c',rewritten], {encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin'}});
    assert.equal(run.status,0,run.stderr); assert.equal(run.stdout,'WRAPPED:sample\n');
  }
});

test('assignment data, lookup arguments and quoted heredocs retain exact contents', () => {
  for (const command of [
    `C=${CODEX_BINARY}; printf '%s\\n' "$C"`,
    `command -v ${CODEX_BINARY}`, `env X=${CODEX_BINARY} printf '%s' data`,
    `cat <<'EOF'\ntime ${CODEX_BINARY}\nEOF`,
    `echo "提示词 中文 ${CODEX_BINARY}"`,
  ]) assert.equal(rewriteCodexCommand(command,root),command);
});

test('unknown executable expansions or shell evaluation stop with an explicit entry instruction', () => {
  for (const command of [
    `C=${CODEX_BINARY}; "$C" exec hi`, `C=${CODEX_BINARY}; C=/bin/echo; "$C" hi`,
    `eval '${CODEX_BINARY} exec hi'`, `bash -c '${CODEX_BINARY} exec hi'`,
    `env -S '${CODEX_BINARY} exec hi'`, `cat <<EOF\n$(${CODEX_BINARY} exec hi)\nEOF`,
    `echo $((1+2)); ${CODEX_BINARY} exec hi`,
  ]) assert.throws(() => rewriteCodexCommand(command,root), /USE_EXPLICIT_CODEX_WRAPPER/);
});

test('earlier process overrides and rule reorderings are refused before the exit probe', async () => {
  const policy = {binary:CODEX_BINARY,proxy:US_PROXY,expectedExitIP:'192.0.2.1',rulesHash:rulesDigest(rules.rules)};
  for (const changed of [
    [{type:'ProcessName',payload:'codex',proxy:'DIRECT'},...rules.rules],
    [...rules.rules].reverse(),
  ]) {
    let probes=0;
    const api=async p=>({'/configs':config,'/proxies':proxies,'/rules':{rules:changed}})[p];
    await assert.rejects(verifyUSRoute(policy,{},api,()=>{probes++;return {ip:'192.0.2.1',country:'US'};}),/RULES_CHANGED/);
    assert.equal(probes,0);
  }
  assert.throws(()=>assertUSPolicy(config,proxies,rules),/BASELINE_REQUIRED/);
  const counters={rules:rules.rules.map(x=>({...x,hitCount:123}))};
  assert.doesNotThrow(()=>assertUSPolicy(config,proxies,counters,policy.rulesHash));
});

test('configuration change during exit check cannot authorize a launch', async () => {
  let changed=false;
  const policy={binary:CODEX_BINARY,proxy:US_PROXY,expectedExitIP:'192.0.2.1',rulesHash:rulesDigest(rules.rules)};
  const api=async p=>({'/configs':config,'/proxies':proxies,'/rules':changed?{rules:[]}:rules})[p];
  await assert.rejects(verifyUSRoute(policy,{},api,()=>{changed=true;return {ip:policy.expectedExitIP,country:'US'};}),/RULES_CHANGED/);
});
