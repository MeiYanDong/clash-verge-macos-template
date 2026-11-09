import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateConfig } from './schema.mjs';
import { buildRouting, gatewaySettings } from './routing.mjs';
import { context, render, chooseServiceUid } from './context.mjs';
import { bindLive } from './attest.mjs';
import { checkPortableBinary } from './binaries.mjs';
import { ROOT,SERVICE_LABEL,LABEL_PREFIX,json,hash,quote,xml,run,writeNew,walk,createPrivateDirectory,requireThat as ok } from './common.mjs';

const coreFiles=['tokyo-egress-latch.mjs','tokyo-practical-runtime.mjs','tokyo-startup-policy.mjs','tokyo-practical-config.mjs','claude-japan-chain.mjs','schema.mjs','common.mjs'];
export function plist(label,args,extra={}) {
  const values={Label:label,ProgramArguments:args,RunAtLoad:true,...extra};
  const value=v=>Array.isArray(v)?`<array>${v.map(value).join('')}</array>`:typeof v==='boolean'?`<${v}/>`:
    typeof v==='number'?`<integer>${v}</integer>`:v&&typeof v==='object'?`<dict>${Object.entries(v).map(([k,x])=>`<key>${xml(k)}</key>${value(x)}`).join('')}</dict>`:`<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value(values)}</plist>\n`;
}
function appInfo(name,binary,id,extra={}) {
  return plist(id,[],{CFBundleName:name,CFBundleDisplayName:name,CFBundleExecutable:binary,
    CFBundleIdentifier:id,CFBundlePackageType:'APPL',CFBundleVersion:'1',LSUIElement:true,...extra});
}
function compile(source,dest,kind,compileEnabled) {
  if(!compileEnabled)return;
  fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
  run('/usr/bin/xcrun',kind==='swift'?['swiftc',source,'-o',dest]:['clang','-fobjc-arc','-Wall','-Werror','-framework',kind==='cocoa'?'Cocoa':'Foundation',source,'-o',dest]);
  fs.chmodSync(dest,0o700);
}
export async function preparePackage(input,out,{demo=false,compileEnabled=true,nodeBinary=process.execPath,mihomoBinary,bind=false,identity,serviceUid,upgrade=false}={}) {
  const c=validateConfig(input,{demo});ok(c.edition==='macos','MACOS_EDITION_REQUIRED');
  ok(!bind||!demo,'DEMO_CANNOT_BIND_LIVE');
  if(compileEnabled) {
    ok(process.platform==='darwin','MACOS_BUILD_REQUIRED');
    for(const binary of [nodeBinary,mihomoBinary]){ok(typeof binary==='string'&&path.isAbsolute(binary),'BINARY_PATH_REQUIRED');checkPortableBinary(binary);}
  }
  const t=context(c,{user:identity,serviceUid:serviceUid??(demo?499:chooseServiceUid(upgrade))});
  const routing=buildRouting(c,{demo});
  const binding=bind?await bindLive(routing,t,mihomoBinary):{rulesHash:'0'.repeat(64),boundAt:null};
  createPrivateDirectory(out);
  const put=(p,b,mode)=>writeNew(path.join(out,p),b,mode);
  put('main.private.yaml',json(routing));put('config.private.json',json(c));
  for(const f of coreFiles)put('system/src/'+f,fs.readFileSync(path.join(ROOT,'src',f)));
  for(const name of ['tokyo-login-preflight.mjs'])put('system/src/'+name,render(name,t));
  put('system/scripts/tokyo-practical-service.mjs',render('tokyo-practical-service.mjs',t));
  put('system/private/settings.private.json',json(gatewaySettings(c,t.SERVICE_UID)));
  put('system/private/startup-intent.json',json({version:1,allowed:true,reason:'USER_INSTALLED'}));
  put('system/startup-config.json',json({version:1,enabled:true,rulesHash:binding.rulesHash,readinessFile:t.READINESS_FILE}));
  put('source/control.m',render('tokyo-gateway-control.m',t));
  compile(path.join(out,'source/control.m'),path.join(out,'system/bin/tokyo-gateway-control'),'foundation',compileEnabled);
  if(compileEnabled) {
    for(const [name,binary] of [['node',nodeBinary],['verge-mihomo',mihomoBinary]]) {
      ok(typeof binary==='string' && path.isAbsolute(binary),'BINARY_PATH_REQUIRED');
      const stat=fs.statSync(binary);ok(stat.isFile(),'BINARY_NOT_REGULAR');
      put('system/bin/'+name,fs.readFileSync(binary),0o755);
    }
    const version=run(path.join(out,'system/bin/node'),['--version']).trim();
    ok(/^v(\d+)\./.test(version)&&Number(version.match(/^v(\d+)/)[1])>=22,'NODE_22_REQUIRED');
  }
  const daemon=plist(SERVICE_LABEL,[t.SYSTEM_ROOT+'/bin/node',t.SYSTEM_ROOT+'/scripts/tokyo-practical-service.mjs',t.SYSTEM_ROOT+'/private/settings.private.json',t.SYSTEM_ROOT+'/bin/verge-mihomo'],
    {UserName:t.SERVICE_USER,GroupName:t.SERVICE_USER,KeepAlive:true,ThrottleInterval:30,WorkingDirectory:t.SYSTEM_ROOT,Umask:63,
      EnvironmentVariables:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},StandardOutPath:'/dev/null',StandardErrorPath:'/dev/null'});
  put('launchd/gateway.plist',daemon);
  put('launchd/preflight.plist',plist(LABEL_PREFIX+'.preflight',[t.SYSTEM_ROOT+'/bin/node',t.SYSTEM_ROOT+'/src/tokyo-login-preflight.mjs'],{KeepAlive:true,ThrottleInterval:10}));
  put('launchd/indicator.plist',plist(LABEL_PREFIX+'.indicator',['/usr/bin/open','-g',t.STATUS_APP]));
  put('source/status.m',render('tokyo-status-view.m',t));
  compile(path.join(out,'source/status.m'),path.join(out,'apps/status/Contents/MacOS/tokyo-status-view'),'cocoa',compileEnabled);
  put('apps/status/Contents/Info.plist',appInfo('Clash Tokyo 状态','tokyo-status-view',LABEL_PREFIX+'.indicator'));
  put('apps/status/Contents/Resources/tokyo-status-input.mjs',render('tokyo-status-input.mjs',t));
  put('apps/status/Contents/Resources/baseline.private.json',json({rulesHash:binding.rulesHash}));
  if(c.features.browser) {
    put('user/browser/runtime.mjs',render('main-chrome-tokyo.mjs',t));
    for(const f of ['manifest.json','background.js','bridge.js'])put('user/browser/extension/'+f,render('browser-extension/'+f,t));
    put('source/policy.swift',render('chrome-policy-readback.swift',t));
    compile(path.join(out,'source/policy.swift'),path.join(out,'user/browser/chrome-policy-readback'),'swift',compileEnabled);
    put('source/browser.swift',render('main-chrome-launcher.swift',t));
    compile(path.join(out,'source/browser.swift'),path.join(out,'apps/browser/Contents/MacOS/launcher'),'swift',compileEnabled);
    put('apps/browser/Contents/Info.plist',appInfo('Clash Tokyo 浏览器','launcher',LABEL_PREFIX+'.browser'));
    const files=['runtime.mjs','extension/background.js','extension/bridge.js','extension/manifest.json',...(compileEnabled?['chrome-policy-readback']:[])];
    put('user/browser/manifest.json',json({format:'main-chrome-tokyo-v1',root:t.BROWSER_ROOT,data:t.BROWSER_DATA,
      proxy:`http://127.0.0.1:${t.GATE_PORT}`,hashes:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(out,'user/browser',f)))]))}));
  }
  if(c.features.login) {
    put('user/login/runtime.mjs',render('tokyo-auth-router.mjs',t));
    put('source/login.swift',render('tokyo-auth-router.swift',t));
    compile(path.join(out,'source/login.swift'),path.join(out,'apps/login/Contents/MacOS/router'),'swift',compileEnabled);
    put('apps/login/Contents/Info.plist',appInfo('Clash Tokyo 登录','router',LABEL_PREFIX+'.login',{
      CFBundleURLTypes:[{CFBundleURLName:'Clash Tokyo HTTPS',CFBundleURLSchemes:['http','https'],CFBundleTypeRole:'Viewer'}],
      ASWebAuthenticationSessionWebBrowserSupportCapabilities:{IsSupported:true,EphemeralBrowserSessionIsSupported:false}}));
    const pairs=[[t.LOGIN_ROOT+'/runtime.mjs','user/login/runtime.mjs'],[t.BROWSER_ROOT+'/runtime.mjs','user/browser/runtime.mjs'],
      ...(compileEnabled?[[t.LOGIN_APP+'/Contents/MacOS/router','apps/login/Contents/MacOS/router']]:[])];
    put('user/login/manifest.json',json({hashes:Object.fromEntries(pairs.map(([a,b])=>[a,hash(fs.readFileSync(path.join(out,b)))]))}));
  }
  if(c.features.tools) {
    put('user/tools/runtime.mjs',render('claude-tool-network.mjs',t));
    const m=await import(pathToFileURL(path.join(out,'user/tools/runtime.mjs')).href);
    put('user/tools/ssh_config',m.renderSsh(c.tools.sshBlocks,t.TOOLS_ROOT,t.HOME));
    put('user/tools/environment.sh',m.renderEnvironment(t.TOOLS_ROOT));
    const files=['runtime.mjs','ssh_config','environment.sh'];
    for(const tool of ['ssh','git','aws',...(c.features.codex?['codex']:[])]) {
      put('user/tools/bin/'+tool,`#!/bin/sh\nexec ${quote(t.SYSTEM_ROOT+'/bin/node')} ${quote(t.TOOLS_ROOT+'/runtime.mjs')} ${tool} "$@"\n`,0o700);
      files.push('bin/'+tool);
    }
    if(c.features.codex) {
      put('user/tools/codex-route.mjs',render('claude-codex-route.mjs',t));files.push('codex-route.mjs');
      put('user/tools/codex-shell-rewrite.py',fs.readFileSync(path.join(ROOT,'src/codex-shell-rewrite.py')));files.push('codex-shell-rewrite.py');
      for(const f of walk(path.join(ROOT,'src/vendor'))) {
        if(f.endsWith('.pyc'))continue;
        const relative=path.relative(path.join(ROOT,'src'),f);put('user/tools/'+relative,fs.readFileSync(f));files.push(relative);
      }
    }
    put('user/tools/profile.json',json({format:'claude-tool-network-v1',uid:t.MAIN_UID,root:t.TOOLS_ROOT,proxy:`http://127.0.0.1:${t.GATE_PORT}`,
      binaries:{ssh:'/usr/bin/ssh',git:'/usr/bin/git',aws:t.AWS_BINARY},acceptedSshFiles:[],
      hashes:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(out,'user/tools',f)))])),
      codex:{enabled:c.features.codex,binary:t.CODEX_BINARY,proxy:`http://127.0.0.1:${t.MAIN_PORT}`,expectedExitIP:t.US_IP,rulesHash:binding.rulesHash}}));
    put('claude-settings.fragment.json',json(m.makeSettings({},t.TOOLS_ROOT,t.SYSTEM_ROOT+'/bin/node')));
  }
  const control=path.join(out,'system/bin/tokyo-gateway-control');
  if(compileEnabled)put('sudoers',`${t.USER} ALL=(${t.SERVICE_USER}) NOPASSWD: NOSETENV: `+
    ['status','arm','lock'].map(cmd=>`sha256:${hash(fs.readFileSync(control))} ${t.SYSTEM_ROOT.replaceAll(' ','\\ ')}/bin/tokyo-gateway-control ${cmd}`).join(', ')+ '\n');
  const files=Object.fromEntries(walk(out).map(f=>[path.relative(out,f),{sha256:hash(fs.readFileSync(f)),mode:fs.statSync(f).mode&0o777}]));
  const manifest={version:1,demo:demo||c.demo,compiled:compileEnabled,bound:!!binding.boundAt,
    createdAt:new Date().toISOString(),context:t,features:c.features,files,binding};
  put('manifest.private.json',json(manifest));
  return {prepared:true,deployable:!manifest.demo&&manifest.compiled&&manifest.bound,files:Object.keys(files).length,productionChanged:false};
}
