import { preflight } from './rendered-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StartupIntent, StartupPolicy, ownedJson, readinessRecord, durableJson } from '../src/tokyo-startup-policy.mjs';
import { TokyoEgressLatch } from '../src/tokyo-egress-latch.mjs';
import { TokyoPracticalRuntime } from '../src/tokyo-practical-runtime.mjs';
const { classifyMain, rulesDigest } = preflight;

const hash = 'a'.repeat(64), challenge = 'b'.repeat(32);
const policy = { enabled: true, delaysMs: [80,120,160], confirmations: 2, confirmationGapMs: 30 };
async function until(fn) { for (let i=0;i<500&&!fn();i++) await delay(5); assert.ok(fn()); }
function directory(t) {
  const d=fs.mkdtempSync('/private/tmp/tokyo-startup-unit-');fs.chmodSync(d,0o700);
  t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;
}
async function ports() {
  const names=['gate','upstream','controller','bygcloud','nexitally'], result={}, servers=[];
  for(const name of names){const s=net.createServer();servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));result[name]=s.address().port;}
  await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));return result;
}
async function fixture(t, options={}) {
  const d=directory(t), file=path.join(d,'intent.json');durableJson(file,{version:1,allowed:true,reason:'USER_ENABLED'});
  const intent=new StartupIntent(file), p=await ports();let readiness='WAITING', healthy=true, failure='UNAVAILABLE';
  const latch=new TokyoEgressLatch({gatePort:p.gate,upstreamPort:p.upstream,intervalMs:25,checkTimeoutMs:200,recovery:policy,
    startCore:async()=>{},stopCore:async()=>true,checkExit:async()=>({healthy,failure}),
    onTrip:(r,m)=>intent.trip(r,m),onReady:()=>intent.ready(),...options});
  await latch.listen();t.after(()=>latch.close());
  const startup=new StartupPolicy({intent,latch,rulesHash:hash,readReadiness:()=>({version:1,pid:process.pid,
    challenge:startup.challenge,at:new Date().toISOString(),status:readiness,rulesHash:hash})});
  return {intent,latch,startup,file,p,readiness:v=>{readiness=v;},health:(v,f='UNAVAILABLE')=>{healthy=v;failure=f;}};
}
async function denied(f) {
  const before=f.latch.snapshot.upstreamDials,c=net.connect(f.p.gate,'127.0.0.1');c.on('error',()=>{});
  await until(()=>c.destroyed);assert.equal(f.latch.snapshot.upstreamDials,before);
}
test('fresh readiness is bound to service instance, pid, exact baseline, and time',()=>{
  const at=Date.now(),r={version:1,pid:5,challenge,status:'VERIFIED',rulesHash:hash,at:new Date(at).toISOString()},ctx={pid:5,challenge,rulesHash:hash,now:at};
  assert.equal(readinessRecord(r,ctx),'VERIFIED');
  for(const patch of [{pid:6},{challenge:'old'},{at:new Date(at-15001).toISOString()},{at:new Date(at+1).toISOString()},{at:'bad'}, {version:2}])
    assert.equal(readinessRecord({...r,...patch},ctx),'WAITING');
  for(const patch of [{rulesHash:'c'.repeat(64)},{status:'MISMATCH'},{status:'invented'}])assert.equal(readinessRecord({...r,...patch},ctx),'MISMATCH');
});
test('missing, corrupt, or unsafe intent never creates an allowed default',t=>{
  const d=directory(t),f=path.join(d,'i.json');assert.equal(new StartupIntent(f).state.allowed,false);
  fs.writeFileSync(f,'invalid',{mode:0o600});assert.equal(new StartupIntent(f).state.allowed,false);
  durableJson(f,{version:1,allowed:true,reason:'VERIFIED'});fs.chmodSync(f,0o666);assert.equal(new StartupIntent(f).state.allowed,false);
  fs.unlinkSync(f);fs.symlinkSync('/etc/hosts',f);assert.equal(new StartupIntent(f).state.allowed,false);
});
test('intent persists manual and safety locks across new policy instances; normal shutdown preserves permission',t=>{
  const d=directory(t),f=path.join(d,'i.json');durableJson(f,{version:1,allowed:true,reason:'USER_ENABLED'});
  const s=new StartupIntent(f);s.trip('SHUTDOWN',{transient:false});assert.equal(new StartupIntent(f).state.allowed,true);
  s.trip('MANUAL_LOCK',{transient:false});assert.equal(new StartupIntent(f).state.reason,'MANUAL_LOCK');
  s.ready();s.trip('EXIT_MISMATCH',{transient:false});assert.equal(new StartupIntent(f).state.reason,'SAFETY_LOCK');
  s.ready();s.trip('EXIT_HEALTH_FAILED',{transient:true});assert.equal(s.state.allowed,true);
  assert.equal(new StartupIntent(f).state.allowed,false);s.trip('SHUTDOWN',{transient:false});assert.equal(new StartupIntent(f).state.allowed,true);
});
test('failed intent write does not grant permission',t=>{
  const d=directory(t),f=path.join(d,'i.json');durableJson(f,{version:1,allowed:false,reason:'MANUAL_LOCK'});
  const s=new StartupIntent(f);fs.chmodSync(d,0o755);assert.throws(()=>s.ready());assert.equal(s.state.allowed,false);fs.chmodSync(d,0o700);
});
test('startup waits for main Clash and loaded rule baseline without starting the core',async t=>{
  const f=await fixture(t);await f.startup.step();await denied(f);
  f.readiness('MISMATCH');await f.startup.step();assert.equal(f.startup.snapshot.state,'WAITING_FOR_VALID_CONFIG');
  assert.equal(f.latch.snapshot.coreStarts,0);assert.equal(f.intent.state.allowed,true);
  f.readiness('VERIFIED');await f.startup.step();assert.equal(f.latch.snapshot.state,'READY');assert.equal(f.latch.snapshot.exitChecks,2);
  assert.equal(f.latch.snapshot.recovery.attempts,0);assert.equal(f.latch.snapshot.recovery.lastRecoveredAt,null);
});
test('no application traffic is admitted between startup confirmation rounds',async t=>{
  let checks=0,release;const f=await fixture(t,{checkExit:async()=>++checks===2?new Promise(r=>{release=r;}):true});
  f.readiness('VERIFIED');const start=f.startup.step();await until(()=>!!release);await denied(f);
  assert.equal(f.latch.snapshot.state,'VERIFYING');assert.equal(new StartupIntent(f.file).state.allowed,false);
  release(true);await start;assert.equal(f.latch.snapshot.state,'READY');assert.equal(f.intent.state.allowed,true);
  assert.equal(new StartupIntent(f.file).state.allowed,false);
});
test('manual lock before startup is not undone by valid readiness or a new coordinator',async t=>{
  const f=await fixture(t);await f.latch.trip('MANUAL_LOCK');f.readiness('VERIFIED');await f.startup.step();await denied(f);
  assert.equal(f.latch.snapshot.coreStarts,0);assert.equal(f.intent.state.allowed,false);
  await assert.rejects(f.latch.armAtStartup(),/CONSUMED/);
});
test('manual lock during the startup second round rejects late success and remains durable',async t=>{
  let checks=0,release;const f=await fixture(t,{checkExit:async()=>++checks===2?new Promise(r=>{release=r;}):true});
  f.readiness('VERIFIED');const start=f.startup.step();await until(()=>!!release);
  await f.latch.trip('MANUAL_LOCK');release(true);await start;await delay(120);
  assert.equal(f.latch.snapshot.state,'LOCKED');assert.equal(new StartupIntent(f.file).state.reason,'MANUAL_LOCK');
});
test('initial transient outage retries within the latch, never by repeated manual arms',async t=>{
  const f=await fixture(t);f.health(false);f.readiness('VERIFIED');await f.startup.step();await denied(f);
  assert.equal(f.latch.snapshot.recovery.timerScheduled,true);await f.startup.step();assert.equal(f.latch.snapshot.coreStarts,1);
  f.health(true);await until(()=>f.latch.snapshot.state==='READY');assert.equal(f.intent.state.allowed,true);
});
for(const failure of ['EXIT_MISMATCH','CHECK_ERROR'])test(`${failure} remains inhibited on restart`,async t=>{
  const f=await fixture(t);f.health(false,failure);f.readiness('VERIFIED');await f.startup.step();await delay(120);
  assert.equal(f.latch.snapshot.state,'LOCKED');assert.equal(f.latch.snapshot.coreStarts,1);
  assert.equal(new StartupIntent(f.file).state.allowed,false);assert.equal(f.latch.snapshot.recovery.timerScheduled,false);
});
test('successful explicit manual arm re-enables next boot after persistent lock',async t=>{
  const f=await fixture(t);await f.latch.trip();assert.equal(f.intent.state.allowed,false);
  assert.equal(await f.latch.armManually(),true);assert.equal(f.intent.state.allowed,true);
  await f.latch.close();assert.equal(new StartupIntent(f.file).state.allowed,true);
});
test('startup API cannot be reused after a successful session or failure',async t=>{
  const f=await fixture(t);f.readiness('VERIFIED');await f.startup.step();await f.latch.trip();
  await assert.rejects(f.latch.armAtStartup(),/CONSUMED/);assert.equal(f.latch.snapshot.state,'LOCKED');
});
test('persistent callback failure still closes the gate and cancels retries',async t=>{
  const f=await fixture(t,{onTrip:()=>{throw Error('disk');}});await f.latch.armManually();f.health(false);
  await until(()=>f.latch.snapshot.state==='LOCKED');assert.equal(f.latch.snapshot.recovery.timerScheduled,false);await denied(f);
});
test('onReady write failure prevents READY',async t=>{
  const f=await fixture(t,{onReady:()=>{throw Error('disk');}});assert.equal(await f.latch.armManually(),false);
  assert.equal(f.latch.snapshot.state,'LOCKED');await denied(f);
});
test('unclean service death cannot reuse a previously verified session permission',async t=>{
  const f=await fixture(t);f.readiness('VERIFIED');await f.startup.step();assert.equal(f.latch.snapshot.state,'READY');
  const afterCrash=new StartupIntent(f.file);assert.equal(afterCrash.state.allowed,false);assert.equal(afterCrash.state.reason,'ACTIVE_SESSION');
  await f.latch.close();assert.equal(new StartupIntent(f.file).state.allowed,true);
});
test('failed manual-lock persistence cannot replay a READY token after restart',async t=>{
  const f=await fixture(t);f.readiness('VERIFIED');await f.startup.step();
  fs.chmodSync(path.dirname(f.file),0o755);await f.latch.trip('MANUAL_LOCK');fs.chmodSync(path.dirname(f.file),0o700);
  assert.equal(f.latch.snapshot.state,'LOCKED');assert.equal(f.intent.state.allowed,false);
  assert.equal(new StartupIntent(f.file).state.allowed,false);
});
test('readiness file wrong owner/mode/symlink is rejected',t=>{
  const d=directory(t),f=path.join(d,'r.json');durableJson(f,{ok:true},0o644);assert.deepEqual(ownedJson(f,process.getuid()),{ok:true});
  assert.throws(()=>ownedJson(f,process.getuid()+1));fs.chmodSync(f,0o666);assert.throws(()=>ownedJson(f,process.getuid()));
  fs.unlinkSync(f);fs.symlinkSync('/etc/hosts',f);assert.throws(()=>ownedJson(f,process.getuid()));
});
test('Clash requires exact ordered rules, TUN, selector with no fallback, and fixed loopback port',()=>{
  const gate='🗼 Claude 东京专线（受控入口）',rules=[{type:'DomainSuffix',payload:'claude.ai',proxy:'Claude · 东京静态住宅'}];
  const good={config:{mode:'rule',tun:{enable:true}},rules,proxies:{'Claude · 东京静态住宅':{type:'Selector',now:gate,all:[gate]},[gate]:{type:'Http'}},
    endpoint:{name:gate,type:'http',server:'127.0.0.1',port:44127}},h=rulesDigest(rules);
  assert.equal(classifyMain(good,h),'VERIFIED');assert.equal(classifyMain({...good,config:null},h),'WAITING');
  assert.equal(classifyMain({...good,config:{mode:'rule',tun:{enable:false}}},h),'WAITING');
  for(const mutate of [c=>c.config.mode='global',c=>delete c.config.tun.enable,c=>c.rules.push({type:'Match',proxy:'DIRECT'}),
    c=>c.proxies['Claude · 东京静态住宅'].all.push('DIRECT'),c=>c.endpoint.port=7897,c=>c.endpoint.server='example.com']){
    const c=structuredClone(good);mutate(c);assert.equal(classifyMain(c,h),'MISMATCH');
  }
});
test('readiness becoming invalid during residential validation cannot open the gate',async t=>{
  const d=directory(t),p=await ports();let ready='VERIFIED';
  const r=new TokyoPracticalRuntime({directory:d,binary:'/bin/false',settings:{uid:process.getuid(),ports:p},readinessCheck:()=>ready});
  r.startCore=async()=>{};r.stopCore=async()=>true;r.checkExit=async()=>{ready='MISMATCH';return true;};
  await r.listen();t.after(()=>r.close());assert.equal(await r.latch.armAtStartup(),false);
  assert.equal(r.snapshot.lastCheckFailure,'CHECK_ERROR');assert.equal(r.latch.snapshot.state,'LOCKED');
});
