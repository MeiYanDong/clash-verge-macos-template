import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/common.mjs';
import { context,render } from '../src/context.mjs';
const c=JSON.parse(fs.readFileSync(path.join(ROOT,'examples/config.example.json')));
const t=context(c,{user:{username:'template',uid:701,homedir:'/Users/template'},serviceUid:480});
async function moduleFixture(name,fn) {
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ct-module-'));
  const file=path.join(dir,name);fs.writeFileSync(file,render(name,t));
  try{await fn(await import(pathToFileURL(file).href));}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('browser keeps per-profile proxy and does not modify daily browser arguments',()=>moduleFixture('main-chrome-tokyo.mjs',m=>{
  const args=m.chromeArgs('http://127.0.0.1:40000/'+'a'.repeat(48)+'/');
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:44127'));
  assert.ok(args.includes('--disable-quic'));assert.ok(args.includes('--disable-sync'));
  assert.ok(!args.includes('--no-proxy-server'));assert.equal(m.EXPECTED_IP,'192.0.2.10');
}));
test('login expiry and bad schemes fail before browser navigation',()=>moduleFixture('tokyo-auth-router.mjs',async m=>{
  const id='12345678-1234-1234-1234-123456789abc';
  for(const url of ['file:///tmp/test','http://example.invalid','https://127.0.0.1','https://user:pass@example.invalid'])
    assert.throws(()=>m.validateRequest({op:'open',sessionID:id,url}));
  assert.throws(()=>m.authorizeState({phase:'armed',sessionID:id,expiresAt:'2000-01-01T00:00:00Z'},id));
  let opened=false;
  await assert.rejects(()=>m.handleRequest({op:'prepare'},{integrity:()=>{},existing:()=>1,probe:async()=>[{matched:false},{matched:true}],open:()=>{opened=true;}}));
  assert.equal(opened,false);
}));
test('tools use HTTP CONNECT to the gate and reject alternate SSH routing',()=>moduleFixture('claude-tool-network.mjs',m=>{
  const root='/Users/template/.config/clash-tokyo-template/tools';
  const ssh=m.renderSsh([{aliases:['server'],options:{hostname:'server.example.invalid',user:'operator'}}],root,'/Users/template');
  assert.ok(ssh.includes('-X connect -x 127.0.0.1:44127'));
  assert.ok(ssh.includes('StrictHostKeyChecking yes'));assert.ok(!ssh.includes('ForwardAgent yes'));
  assert.throws(()=>m.sshArguments(['-o','ProxyCommand=direct','server'],{root,acceptedSshFiles:[],sshAliases:['server']}));
  const input={env:{UNRELATED:'keep'},hooks:{}};const next=m.makeSettings(input,root,'/usr/local/bin/node');
  assert.equal(next.env.UNRELATED,'keep');assert.equal(input.env.HTTP_PROXY,undefined);
  assert.equal(next.env.HTTPS_PROXY,'http://127.0.0.1:44127');
  assert.throws(()=>m.makeSettings({env:{HTTPS_PROXY:'http://example.invalid'}},root,'/usr/local/bin/node'));
}));
test('Codex overrides only its child environment; original Claude environment stays Tokyo',()=>moduleFixture('claude-codex-route.mjs',m=>{
  const root='/Users/template/.config/clash-tokyo-template/tools';
  const env={HTTPS_PROXY:'http://127.0.0.1:44127',PATH:root+'/bin:/usr/bin',GIT_SSH_COMMAND:`'${root}/bin/ssh'`};
  const next=m.codexEnvironment(root,env);
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:44127');assert.equal(next.HTTPS_PROXY,'http://127.0.0.1:7897');
  assert.equal(next.GIT_SSH_COMMAND,undefined);assert.equal(next.PATH,'/usr/bin');
}));
