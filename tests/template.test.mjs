import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT,json,hash } from '../src/common.mjs';
import { validateConfig } from '../src/schema.mjs';
import { buildRouting,gatewaySettings,N,appRules,CLAUDE_DOMAINS } from '../src/routing.mjs';
import { context,render } from '../src/context.mjs';
import { preparePackage } from '../src/package.mjs';
import { verifyPackage,installSystem } from '../src/install.mjs';
import { compareRendered,compareLive,rulesDigest } from '../src/attest.mjs';
import { audit,inspectText } from '../scripts/public-audit.mjs';

const fixture=()=>JSON.parse(fs.readFileSync(path.join(ROOT,'examples/config.example.json')));
test('example cannot be rendered for deployment without explicit demo mode',()=>{
  assert.throws(()=>validateConfig(fixture()),/DEMO/);
  const c=fixture();c.demo=false;assert.throws(()=>validateConfig(c),/EXAMPLE_NOT_DEPLOYABLE/);
});
test('macOS policy does not inherit provider rules and keeps Claude before shared US domains',()=>{
  const c=fixture();c.providers[0].rules=['MATCH,DIRECT'];const before=json(c),r=buildRouting(c,{demo:true});
  assert.equal(json(c),before);assert.deepEqual(r.rules.slice(0,2),appRules('Claude',N.tokyo));
  assert.ok(r.rules.indexOf('DOMAIN-SUFFIX,stripe.com,'+N.usGroup)>1);
  assert.deepEqual(r['proxy-groups'].find(g=>g.name===N.tokyo).proxies,[N.gate]);
  assert.deepEqual(r.proxies.find(p=>p.name===N.gate),{name:N.gate,type:'http',server:'127.0.0.1',port:44127});
  for(const d of CLAUDE_DOMAINS)assert.ok(r.rules.includes(`DOMAIN-SUFFIX,${d},${N.tokyo}`));
});
test('US uses ordered primary fallback while both choices still use one residence',()=>{
  const r=buildRouting(fixture(),{demo:true});
  const us=r['proxy-groups'].find(g=>g.name===N.us);
  assert.equal(us.type,'fallback');assert.deepEqual(us.proxies,['bygcloud-us','nexitally-us']);
  assert.equal(r.proxies.find(p=>p.name===N.usExit)['dialer-proxy'],N.front);
  assert.ok(!r['proxy-groups'].some(g=>g.proxies?.includes('DIRECT')));
});
test('standalone basic edition has full residential chains and no localhost gateway dependency',()=>{
  const c=fixture();c.edition='basic';const r=buildRouting(c,{demo:true});
  assert.ok(!r.proxies.some(p=>p.server==='127.0.0.1'));
  const group=r['proxy-groups'].find(g=>g.name===N.tokyo);
  assert.equal(group.type,'fallback');assert.equal(group.proxies.length,2);
  const exits=group.proxies.map(n=>r.proxies.find(p=>p.name===n));
  assert.equal(exits[0].server,exits[1].server);assert.notEqual(exits[0]['dialer-proxy'],exits[1]['dialer-proxy']);
});
test('unsafe routes and invalid private inputs fail before generating files',()=>{
  for(const change of [c=>c.tokyo.ports.gate=c.main.port,c=>c.providers[0].nodes[0]['dialer-proxy']='DIRECT',
    c=>c.providers[0].subscriptionUrl='http://example.invalid/sub',c=>c.tokyo.transitNames.bygcloud='USA Primary',
    c=>c.features.browser=false,c=>c.directDomains=['foo\nMATCH,DIRECT']]) {
    const c=fixture();c.features.login=true;change(c);assert.throws(()=>validateConfig(c,{demo:true}));
  }
});
test('identity is discovered/parameterized; source templates contain no unresolved runtime data',()=>{
  const c=validateConfig(fixture(),{demo:true});
  const t=context(c,{user:{username:'template',uid:701,homedir:'/Users/template'},serviceUid:480});
  const service=render('tokyo-practical-service.mjs',t);
  assert.ok(service.includes('ownedJson(READINESS_FILE, 701)'));
  assert.ok(!service.includes('@@'));assert.equal(t.MAIN_SOCKET,'/var/run/clash-verge-service/users/701/verge-mihomo.sock');
  assert.throws(()=>context(c,{user:{username:'template',uid:701,homedir:'/Users/template\nboom'}}));
  assert.equal(gatewaySettings(c,480).uid,480);
});
test('package can be built without installing anything; demo and tampering cannot be installed',async t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ct-template-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const out=path.join(dir,'package');const result=await preparePackage(fixture(),out,{demo:true,compileEnabled:false});
  assert.equal(result.productionChanged,false);assert.equal(result.deployable,false);
  assert.equal(verifyPackage(out).m.bound,false);assert.equal(installSystem(out).touchesClash,false);
  assert.throws(()=>verifyPackage(out,{requireDeployable:true}),/NOT_DEPLOYABLE/);
  const f=path.join(out,'system/src/tokyo-egress-latch.mjs');fs.appendFileSync(f,'\n// modified');
  assert.throws(()=>verifyPackage(out),/HASH_CHANGED/);
});
test('rule binding rejects same-target tampering and rule reordering',()=>{
  const r=buildRouting(fixture(),{demo:true});
  assert.doesNotThrow(()=>compareRendered(r,structuredClone(r)));
  const altered=structuredClone(r);altered.rules.reverse();assert.throws(()=>compareRendered(r,altered));
  const rules=r.rules.map((x,i)=>({type:'fixture',payload:String(i),proxy:x.split(',').at(-1)}));
  const live={config:{mode:'rule',tun:{enable:true},'mixed-port':r['mixed-port']},rules:structuredClone(rules),proxies:{
    [N.tokyo]:{type:'Selector',now:N.gate,all:[N.gate]},[N.gate]:{type:'Http'},[N.usGroup]:{now:N.usExit,all:[N.usExit]}}};
  assert.equal(compareLive(r,live,rules),rulesDigest(rules));
  live.rules[0].payload='changed but same proxy';assert.throws(()=>compareLive(r,live,rules),/CONTENT_CHANGED/);
});
test('secret scanner detects private paths, addresses and access tokens without printing values',()=>{
  const home='/Users/'+'private_person/file';assert.ok(inspectText(home).includes('PERSONAL_HOME_PATH'));
  const ip=['92','112','254','166'].join('.');assert.ok(inspectText(ip).includes('UNREVIEWED_PUBLIC_IP'));
  const token='AK'+'IA'+'Z'.repeat(16);assert.ok(inspectText(token).includes('ACCESS_TOKEN'));
  assert.deepEqual(inspectText('192.0.2.10 https://example.invalid EXAMPLE_ONLY'),[]);
});
test('CLI help and doctor on a clean machine have no setup side effects',()=>{
  const r=spawnSync(process.execPath,['scripts/toolkit.mjs','help'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).default,'install/uninstall only print a plan without --apply');
});
test('public source audit is clean',()=>{const r=audit();assert.deepEqual(r.issues,[]);});
