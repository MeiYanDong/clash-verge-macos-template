#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ROOT,json,hash,readPrivate,writeNew,createPrivateDirectory,requireThat as ok,SYSTEM_ROOT,run } from '../src/common.mjs';
import { validateConfig } from '../src/schema.mjs';
import { buildRouting,gatewaySettings } from '../src/routing.mjs';
import { preparePackage } from '../src/package.mjs';
import { installSystem,installUser,upgradeUser,installTools,uninstallSystem,uninstallUser,verifyPackage } from '../src/install.mjs';

function options(args) {
  const result={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];ok(/^--[a-z-]+$/.test(key)&&!Object.hasOwn(result,key),'ARGUMENTS');
    result[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;
  }
  return result;
}
function config(file,demo=false) {
  ok(typeof file==='string','CONFIG_PATH_REQUIRED');
  const p=path.resolve(file);
  const example=path.join(ROOT,'examples/config.example.json');
  return validateConfig(JSON.parse(p===example&&demo?fs.readFileSync(p):readPrivate(p)),{demo});
}
async function main() {
  const [command,...args]=process.argv.slice(2),o=options(args),demo=o['--demo']===true;
  const allowed={init:['--out'],render:['--config','--out','--demo'],prepare:['--config','--out','--demo','--mihomo','--node','--no-compile','--bind-live','--upgrade'],
    'verify-package':['--package'],'install-system':['--package','--apply','--upgrade'],'install-user':['--package','--apply'],'upgrade-user':['--package','--apply'],'install-tools':['--package','--apply'],
    'uninstall-system':['--apply'],'uninstall-user':['--apply'],doctor:[],help:[]};
  ok(command in allowed && Object.keys(o).every(k=>allowed[command].includes(k)),'UNKNOWN_COMMAND_OR_OPTION');
  if(command==='help')return {commands:Object.keys(allowed),default:'install/uninstall only print a plan without --apply',guide:'docs/INSTALL.md'};
  if(command==='init') {
    ok(typeof o['--out']==='string','OUTPUT_REQUIRED');
    writeNew(path.resolve(o['--out']),fs.readFileSync(path.join(ROOT,'examples/config.example.json')));
    return {created:true,mode:'0600',next:'Edit your private configuration. Example values cannot be deployed.'};
  }
  if(command==='render') {
    const c=config(o['--config'],demo);ok(typeof o['--out']==='string','OUTPUT_REQUIRED');
    const out=path.resolve(o['--out']);createPrivateDirectory(out);
    const main=buildRouting(c,{demo});writeNew(path.join(out,'main.private.yaml'),json(main));
    writeNew(path.join(out,'gateway-input.private.json'),json(gatewaySettings(c,null)));
    writeNew(path.join(out,'receipt.json'),json({version:1,demo:demo||c.demo,edition:c.edition,rules:main.rules.length,configHash:hash(json(main)),installed:false}));
    return {rendered:true,edition:c.edition,rules:main.rules.length,installed:false,liveNetworkAccess:false};
  }
  if(command==='prepare') {
    ok(typeof o['--out']==='string','OUTPUT_REQUIRED');
    return preparePackage(config(o['--config'],demo),path.resolve(o['--out']),{demo,compileEnabled:!o['--no-compile'],
      mihomoBinary:o['--mihomo'],nodeBinary:o['--node']||process.execPath,bind:o['--bind-live']===true,upgrade:o['--upgrade']===true});
  }
  if(command==='verify-package') {const {m}=verifyPackage(o['--package']);return {verified:true,compiled:m.compiled,bound:m.bound,demo:m.demo};}
  if(command==='install-system')return installSystem(o['--package'],{apply:o['--apply']===true,upgrade:o['--upgrade']===true});
  if(command==='install-user')return installUser(o['--package'],{apply:o['--apply']===true});
  if(command==='upgrade-user')return upgradeUser(o['--package'],{apply:o['--apply']===true});
  if(command==='install-tools')return installTools(o['--package'],{apply:o['--apply']===true});
  if(command==='uninstall-system')return uninstallSystem({apply:o['--apply']===true});
  if(command==='uninstall-user')return uninstallUser({apply:o['--apply']===true});
  if(command==='doctor') {
    if(!fs.existsSync(SYSTEM_ROOT+'/bin/tokyo-gateway-control'))return {installed:false,networkChanged:false};
    const r=JSON.parse(run('/usr/bin/sudo',['-n','-k','-u','_cttokyo','--',SYSTEM_ROOT+'/bin/tokyo-gateway-control','status']));
    return {installed:true,state:r.latch?.state,coreRunning:r.coreRunning,selectedLane:r.selectedLane,startup:r.startup?.state,
      lastProbe:r.probes?.at(-1)?{at:r.probes.at(-1).at,outcome:r.probes.at(-1).outcome}:null,scope:r.scope};
  }
}
main().then(result=>console.log(json(result))).catch(e=>{
  // Do not echo parser excerpts, paths with tokens, subscriptions or credentials.
  console.error(/^[A-Z][A-Z_]{2,100}$/.test(e.message)?e.message:'OPERATION_FAILED_DETAILS_REDACTED');process.exitCode=1;
});
