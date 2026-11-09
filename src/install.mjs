import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { context } from './context.mjs';
import { validateConfig } from './schema.mjs';
import { SYSTEM_ROOT,SERVICE_USER,SERVICE_LABEL,LABEL_PREFIX,hash,json,noLinks,readPrivate,writeNew,walk,run,requireThat as ok } from './common.mjs';

export const DAEMON='/Library/LaunchDaemons/'+SERVICE_LABEL+'.plist';
export const SUDOERS='/private/etc/sudoers.d/clashtokyo-template';
const RECORD=SYSTEM_ROOT+'/installation.json';
export function verifyPackage(directory,{requireDeployable=false}={}) {
  const dir=path.resolve(directory);noLinks(dir);
  const owner=fs.statSync(dir).uid;
  const m=JSON.parse(readPrivate(path.join(dir,'manifest.private.json'),owner));
  ok(m.version===1 && owner===m.context?.MAIN_UID,'PACKAGE_IDENTITY_INVALID');
  const actual=walk(dir).map(f=>path.relative(dir,f)).filter(f=>f!=='manifest.private.json').sort();
  assert.deepEqual(actual,Object.keys(m.files).sort(),'PACKAGE_FILE_SET_CHANGED');
  for(const file of actual) {
    ok(!path.isAbsolute(file) && !file.split('/').includes('..') && !file.includes('\\'),'PACKAGE_PATH_INVALID');
    const full=path.join(dir,file),s=fs.lstatSync(full);
    ok(s.uid===owner && !(s.mode&0o022) && s.nlink===1,'PACKAGE_FILE_UNSAFE');
    ok(hash(fs.readFileSync(full))===m.files[file].sha256,'PACKAGE_HASH_CHANGED');
    ok((s.mode&0o777)===m.files[file].mode,'PACKAGE_MODE_CHANGED');
  }
  const c=validateConfig(JSON.parse(readPrivate(path.join(dir,'config.private.json'),owner)),{demo:m.demo});
  const expected=context(c,{user:{username:m.context.USER,uid:owner,homedir:m.context.HOME},serviceUid:m.context.SERVICE_UID});
  assert.deepEqual(m.context,expected,'PACKAGE_CONTEXT_CHANGED');
  assert.deepEqual(m.features,c.features,'PACKAGE_FEATURES_CHANGED');
  if(requireDeployable)ok(!m.demo && !c.demo && m.compiled===true && m.bound===true && /^[a-f0-9]{64}$/.test(m.binding?.rulesHash),'PACKAGE_NOT_DEPLOYABLE');
  return {dir,m,c};
}
export function installPlan(directory) {
  const {m}=verifyPackage(directory);
  return {operation:'install',deployable:!m.demo&&m.compiled&&m.bound,requiresAdmin:true,
    creates:[SYSTEM_ROOT,DAEMON,SUDOERS,path.dirname(m.context.READINESS_FILE)],
    serviceIdentity:SERVICE_USER,serviceUid:m.context.SERVICE_UID,mainUid:m.context.MAIN_UID,
    touchesClash:false,startsClaude:false,changesDefaultBrowser:false};
}
function assertPlatform() { ok(process.platform==='darwin','MACOS_REQUIRED'); }
function absent(p) {noLinks(p);ok(!fs.existsSync(p),'INSTALL_TARGET_EXISTS');}
function copyFile(from,to,uid,gid,mode,expected) {
  noLinks(to);fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o755});
  const data=fs.readFileSync(from);if(expected)ok(hash(data)===expected,'PACKAGE_CHANGED_DURING_COPY');
  writeNew(to,data,mode);fs.chownSync(to,uid,gid);fs.chmodSync(to,mode);
}
function accountFree(t) {
  for(const [kind,attribute] of [['Users','UniqueID'],['Groups','PrimaryGroupID']]) {
    const rows=run('/usr/bin/dscl',['.','-list','/'+kind,attribute]).split('\n');
    ok(!rows.some(l=>new RegExp(`^${SERVICE_USER}\\s`).test(l) || Number(l.trim().split(/\s+/).at(-1))===t.SERVICE_UID),'SERVICE_IDENTITY_COLLISION');
  }
}
export function checkInstalledRecord(m) {
  ok(m.version===1&&m.context?.SYSTEM_ROOT===SYSTEM_ROOT,'INSTALL_RECEIPT_INVALID');
  for(const [f,digest]of Object.entries(m.files)) {
    ok(f.startsWith(SYSTEM_ROOT+'/')||[DAEMON,SUDOERS].includes(f),'INSTALL_RECEIPT_PATH_INVALID');
    noLinks(f);ok(fs.statSync(f).uid===0&&hash(fs.readFileSync(f))===digest,'INSTALLED_FILE_CHANGED_REVIEW');
  }
}
export function installSystem(directory,{apply=false,upgrade=false}={}) {
  if(!apply)return {...installPlan(directory),operation:upgrade?'upgrade-system':'install',upgradeRequiresSameManagedIdentity:upgrade};
  assertPlatform();ok(process.getuid()===0 && process.geteuid()===0,'ADMIN_REQUIRED');
  const {dir,m}=verifyPackage(directory,{requireDeployable:true}),t=m.context;
  let previous=null,archive=null;
  if(upgrade) {
    noLinks(RECORD);previous=JSON.parse(fs.readFileSync(RECORD));checkInstalledRecord(previous);
    for(const k of ['MAIN_UID','SERVICE_UID','USER','HOME','SERVICE_USER','READINESS_FILE'])ok(previous.context[k]===t[k],'UPGRADE_IDENTITY_CHANGED');
    ok(run('/usr/bin/id',['-u',SERVICE_USER]).trim()===String(t.SERVICE_UID),'SERVICE_IDENTITY_CHANGED');
  } else for(const p of [SYSTEM_ROOT,DAEMON,SUDOERS,path.dirname(t.READINESS_FILE)])absent(p);
  ok(run('/usr/bin/id',['-u',t.USER]).trim()===String(t.MAIN_UID),'MAIN_USER_CHANGED');if(!upgrade)accountFree(t);
  // All package checks occur before creating identities or touching launchd.
  run('/usr/sbin/visudo',['-cf',path.join(dir,'sudoers')]);run('/usr/bin/plutil',['-lint',path.join(dir,'launchd/gateway.plist')]);
  let phase='ACCOUNT';
  try {
    if(upgrade) {
      run('/bin/launchctl',['bootout','system/'+SERVICE_LABEL]);
      archive=SYSTEM_ROOT+'.previous-'+Date.now();fs.renameSync(SYSTEM_ROOT,archive);fs.chmodSync(archive,0o700);
      copyFile(DAEMON,archive+'/upgrade-backup/gateway.plist',0,0,0o600,previous.files[DAEMON]);
      copyFile(SUDOERS,archive+'/upgrade-backup/sudoers',0,0,0o600,previous.files[SUDOERS]);
      fs.unlinkSync(DAEMON);fs.unlinkSync(SUDOERS);
    } else {
      run('/usr/bin/dscl',['.','-create','/Groups/'+SERVICE_USER]);
      run('/usr/bin/dscl',['.','-create','/Groups/'+SERVICE_USER,'PrimaryGroupID',String(t.SERVICE_UID)]);
      run('/usr/bin/dscl',['.','-create','/Users/'+SERVICE_USER]);
      for(const [k,v] of Object.entries({UniqueID:t.SERVICE_UID,PrimaryGroupID:t.SERVICE_UID,NFSHomeDirectory:'/var/empty',UserShell:'/usr/bin/false',IsHidden:1,Password:'*'}))
        run('/usr/bin/dscl',['.','-create','/Users/'+SERVICE_USER,k,String(v)]);
    }
    phase='FILES';fs.mkdirSync(SYSTEM_ROOT,{mode:0o755});
    fs.mkdirSync(SYSTEM_ROOT+'/private',{mode:0o700});fs.chownSync(SYSTEM_ROOT+'/private',t.SERVICE_UID,t.SERVICE_UID);
    for(const rel of Object.keys(m.files).filter(x=>x.startsWith('system/'))) {
      const file=rel.slice(7),priv=file.startsWith('private/');
      copyFile(path.join(dir,rel),path.join(SYSTEM_ROOT,file),priv?t.SERVICE_UID:0,priv?t.SERVICE_UID:0,priv?0o600:file.startsWith('bin/')?0o755:0o644,m.files[rel].sha256);
    }
    if(upgrade)fs.writeFileSync(SYSTEM_ROOT+'/private/startup-intent.json',json({version:1,allowed:false,reason:'UPGRADE_REVIEW'}),{mode:0o600});
    const shared=path.dirname(t.READINESS_FILE);if(!upgrade){fs.mkdirSync(shared,{mode:0o755});fs.chownSync(shared,t.MAIN_UID,20);}
    copyFile(path.join(dir,'sudoers'),SUDOERS,0,0,0o440,m.files.sudoers.sha256);
    copyFile(path.join(dir,'launchd/gateway.plist'),DAEMON,0,0,0o644,m.files['launchd/gateway.plist'].sha256);
    run('/usr/sbin/visudo',['-cf','/private/etc/sudoers']);
    const installed=Object.fromEntries(Object.keys(m.files).filter(f=>f.startsWith('system/')&&!f.startsWith('system/private/')).map(f=>[path.join(SYSTEM_ROOT,f.slice(7)),m.files[f].sha256]));
    installed[SUDOERS]=m.files.sudoers.sha256;installed[DAEMON]=m.files['launchd/gateway.plist'].sha256;
    writeNew(RECORD,json({version:1,status:'installed',context:t,files:installed}),0o644);
    phase='START';run('/bin/launchctl',['bootstrap','system',DAEMON]);
    return {installed:true,upgraded:upgrade,service:SERVICE_LABEL,startsLocked:true,userAgentsPending:true,clashChanged:false,manualArmAfterUpgrade:upgrade};
  } catch {
    // Remove only our grant and our daemon. Keep failed install files/identity
    // for diagnosis; do not remove an account if a concurrent actor changed it.
    try{run('/bin/launchctl',['bootout','system/'+SERVICE_LABEL]);}catch{}
    for(const [file,rel] of [[SUDOERS,'sudoers'],[DAEMON,'launchd/gateway.plist']])try{
      if(fs.existsSync(file)&&hash(fs.readFileSync(file))===m.files[rel].sha256)fs.unlinkSync(file);
    }catch{}
    if(archive)try {
      if(fs.existsSync(SYSTEM_ROOT)){const failed=SYSTEM_ROOT+'.failed-'+Date.now();fs.renameSync(SYSTEM_ROOT,failed);fs.chmodSync(failed,0o700);}
      fs.renameSync(archive,SYSTEM_ROOT);fs.chmodSync(SYSTEM_ROOT,0o755);
      for(const [file,backup,mode]of [[DAEMON,'gateway.plist',0o644],[SUDOERS,'sudoers',0o440]]) {
        if(!fs.existsSync(file))copyFile(SYSTEM_ROOT+'/upgrade-backup/'+backup,file,0,0,mode,previous.files[file]);
      }
      checkInstalledRecord(previous);run('/usr/sbin/visudo',['-cf','/private/etc/sudoers']);run('/bin/launchctl',['bootstrap','system',DAEMON]);
    }catch{throw Error('UPGRADE_ROLLBACK_NEEDS_REVIEW_GATE_CLOSED');}
    throw Error('INSTALL_STOPPED_'+phase+'_FILES_RETAINED');
  }
}
export function installUser(directory,{apply=false}={}) {
  const {dir,m}=verifyPackage(directory,{requireDeployable:apply}),t=m.context;
  const base=path.dirname(t.BROWSER_ROOT),agentDir=path.join(t.HOME,'Library/LaunchAgents');
  const apps=[['status',t.STATUS_APP],...(m.features.browser?[['browser',t.BROWSER_APP]]:[]),...(m.features.login?[['login',t.LOGIN_APP]]:[])];
  if(!apply)return {operation:'install-user',creates:[base,...apps.map(x=>x[1])],admin:false,changesClaudeSettings:false,startsBrowser:false,startsClaude:false};
  assertPlatform();ok(process.getuid()===t.MAIN_UID && process.geteuid()===t.MAIN_UID,'MAIN_USER_REQUIRED');
  ok(fs.existsSync(SYSTEM_ROOT+'/startup-config.json'),'INSTALL_SYSTEM_FIRST');
  ok(JSON.parse(fs.readFileSync(SYSTEM_ROOT+'/startup-config.json')).rulesHash===m.binding.rulesHash,'SYSTEM_PACKAGE_MISMATCH');
  for(const p of [base,...apps.map(x=>x[1]),...['preflight','indicator'].map(x=>path.join(agentDir,LABEL_PREFIX+'.'+x+'.plist'))])absent(p);
  noLinks(agentDir);fs.mkdirSync(agentDir,{recursive:true,mode:0o700});
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const copied={};
  const copyTree=(from,to)=>{for(const f of walk(from)){const dest=path.join(to,path.relative(from,f));
    copyFile(f,dest,t.MAIN_UID,process.getgid(),fs.statSync(f).mode&0o111?0o700:0o600,m.files[path.relative(dir,f)].sha256);copied[dest]=hash(fs.readFileSync(dest));}};
  try {
    for(const [name,app]of apps)copyTree(path.join(dir,'apps',name),app);
    if(fs.existsSync(path.join(dir,'user')))copyTree(path.join(dir,'user'),base);
    if(m.features.browser)fs.mkdirSync(t.BROWSER_DATA,{mode:0o700});
    for(const name of ['preflight','indicator']) {
      const dest=path.join(agentDir,LABEL_PREFIX+'.'+name+'.plist');
      copyFile(path.join(dir,'launchd',name+'.plist'),dest,t.MAIN_UID,process.getgid(),0o600);copied[dest]=hash(fs.readFileSync(dest));
    }
    writeNew(path.join(base,'install-receipt.json'),json({version:1,context:t,features:m.features,files:copied}),0o600);
    for(const name of ['preflight','indicator'])run('/bin/launchctl',['bootstrap',`gui/${t.MAIN_UID}`,path.join(agentDir,LABEL_PREFIX+'.'+name+'.plist')]);
    return {installed:true,clashChanged:false,claudeSettingsChanged:false,browserNotStarted:true,extensionInstallRequired:m.features.browser};
  } catch {throw Error('USER_INSTALL_INCOMPLETE_KEEP_FILES_FOR_RECOVERY');}
}
export function upgradeUser(directory,{apply=false}={}) {
  const {dir,m}=verifyPackage(directory,{requireDeployable:apply}),t=m.context,base=path.dirname(t.BROWSER_ROOT);
  if(!apply)return {operation:'upgrade-user',requiresTemplateAppsClosed:true,preservesBrowserProfile:true,preservesClaudeSettings:true,admin:false};
  assertPlatform();ok(process.getuid()===t.MAIN_UID&&process.geteuid()===t.MAIN_UID,'MAIN_USER_REQUIRED');
  const receipt=path.join(base,'install-receipt.json'),old=JSON.parse(readPrivate(receipt));
  for(const k of ['USER','HOME','MAIN_UID','SERVICE_UID','SYSTEM_ROOT'])ok(old.context?.[k]===t[k],'UPGRADE_IDENTITY_CHANGED');
  assert.deepEqual(old.features,m.features,'FEATURE_CHANGE_REQUIRES_SEPARATE_REVIEW');
  const state=path.join(t.LOGIN_ROOT,'state.json');
  if(fs.existsSync(state))ok(JSON.parse(readPrivate(state)).phase==='closed','END_LOGIN_MODE_FIRST');
  const ps=run('/bin/ps',['-axo','uid=,command=']);
  ok(!ps.split('\n').some(l=>new RegExp(`^\\s*${t.MAIN_UID}\\s+`).test(l)&&
    ([t.STATUS_APP,t.BROWSER_APP,t.LOGIN_APP,t.BROWSER_DATA,'/Applications/Claude.app/'].some(p=>l.includes(p)))),'CLOSE_TEMPLATE_APPS_AND_CLAUDE_FIRST');
  const allowed=p=>p.startsWith(base+'/')||[t.STATUS_APP,t.BROWSER_APP,t.LOGIN_APP].some(a=>p.startsWith(a+'/'))||
    ['preflight','indicator'].some(n=>p===path.join(t.HOME,'Library/LaunchAgents',LABEL_PREFIX+'.'+n+'.plist'));
  for(const [file,digest]of Object.entries(old.files)){ok(allowed(file),'USER_RECEIPT_PATH_INVALID');noLinks(file);ok(hash(fs.readFileSync(file))===digest,'USER_FILE_CHANGED_REVIEW');}
  const files={};
  const add=(from,to)=>{for(const f of walk(from))files[path.join(to,path.relative(from,f))]=f;};
  for(const [name,app]of [['status',t.STATUS_APP],...(m.features.browser?[['browser',t.BROWSER_APP]]:[]),...(m.features.login?[['login',t.LOGIN_APP]]:[])])add(path.join(dir,'apps',name),app);
  if(fs.existsSync(path.join(dir,'user')))add(path.join(dir,'user'),base);
  for(const n of ['preflight','indicator'])files[path.join(t.HOME,'Library/LaunchAgents',LABEL_PREFIX+'.'+n+'.plist')]=path.join(dir,'launchd',n+'.plist');
  ok(Object.keys(old.files).every(f=>files[f]),'UPGRADE_REMOVED_FILE_REVIEW');
  const backup=path.join(base,'.upgrades',String(Date.now()));fs.mkdirSync(backup,{recursive:true,mode:0o700});
  const saved=new Map(Object.keys(old.files).map(f=>[f,fs.readFileSync(f)]));saved.set(receipt,fs.readFileSync(receipt));
  let i=0;for(const [file,data]of saved)writeNew(path.join(backup,String(i++)+'.private'),data);
  const replace=(file,data,mode)=>{const tmp=file+'.ct-update';writeNew(tmp,data,mode);fs.renameSync(tmp,file);};
  for(const n of ['preflight','indicator'])try{run('/bin/launchctl',['bootout',`gui/${t.MAIN_UID}/${LABEL_PREFIX}.${n}`]);}catch{}
  try {
    const next={};
    for(const [dest,source]of Object.entries(files)) {
      const data=fs.readFileSync(source),rel=path.relative(dir,source);ok(hash(data)===m.files[rel].sha256,'PACKAGE_CHANGED_DURING_COPY');
      replace(dest,data,fs.statSync(source).mode&0o111?0o700:0o600);next[dest]=hash(data);
    }
    replace(receipt,json({version:1,context:t,features:m.features,files:next}),0o600);
    for(const n of ['preflight','indicator'])run('/bin/launchctl',['bootstrap',`gui/${t.MAIN_UID}`,path.join(t.HOME,'Library/LaunchAgents',LABEL_PREFIX+'.'+n+'.plist')]);
    return {upgraded:true,browserDataPreserved:true,claudeSettingsPreserved:true,backup};
  } catch {
    for(const [f,data]of saved)replace(f,data,f.includes('/MacOS/')||f.includes('/bin/')||f.endsWith('/chrome-policy-readback')?0o700:0o600);
    for(const f of Object.keys(files).filter(f=>!saved.has(f)))if(fs.existsSync(f))fs.unlinkSync(f);
    throw Error('USER_UPGRADE_ROLLED_BACK_AGENTS_REQUIRE_RESTART');
  }
}
export function uninstallSystem({apply=false}={}) {
  if(!apply)return {operation:'uninstall',stopsOnly:SERVICE_LABEL,archives:SYSTEM_ROOT,removes:[DAEMON,SUDOERS],keepsServiceIdentity:true,
    instruction:'先在 Clash 选择其他有效配置；卸载不会给 Claude 添加直连回退。'};
  assertPlatform();ok(process.getuid()===0,'ADMIN_REQUIRED');noLinks(RECORD);
  ok(fs.statSync(RECORD).uid===0&&!(fs.statSync(RECORD).mode&0o022),'INSTALL_RECEIPT_UNSAFE');
  const m=JSON.parse(fs.readFileSync(RECORD));checkInstalledRecord(m);
  try{run('/bin/launchctl',['bootout','system/'+SERVICE_LABEL]);}catch{run('/bin/launchctl',['print','system/'+SERVICE_LABEL]);throw Error('SERVICE_STOP_UNCONFIRMED');}
  fs.unlinkSync(SUDOERS);fs.unlinkSync(DAEMON);run('/usr/sbin/visudo',['-cf','/private/etc/sudoers']);
  const archived=SYSTEM_ROOT+'.disabled-'+Date.now();fs.renameSync(SYSTEM_ROOT,archived);fs.chmodSync(archived,0o700);
  return {uninstalled:true,archived,credentialsRetainedPrivately:true,serviceAccountRetained:true,clashChanged:false};
}
export async function installTools(directory,{apply=false}={}) {
  const {m}=verifyPackage(directory,{requireDeployable:apply}),t=m.context;
  ok(m.features.tools,'TOOLS_NOT_INCLUDED');
  if(!apply)return {operation:'install-tools',target:path.join(t.HOME,'.claude/settings.json'),backsUpOriginal:true,readsKeys:false,requiresClaudeClosed:true};
  ok(process.getuid()===t.MAIN_UID&&process.geteuid()===t.MAIN_UID,'MAIN_USER_REQUIRED');
  const ps=run('/bin/ps',['-axo','uid=,comm=']);
  ok(!ps.split('\n').some(l=>new RegExp(`^\\s*${t.MAIN_UID}\\s+`).test(l)&&/\/Claude\.app\/|\/claude\/versions\/|\/bin\/claude$/.test(l)),'QUIT_CLAUDE_BEFORE_HOOK_CHANGE');
  const runtime=path.join(t.TOOLS_ROOT,'runtime.mjs');noLinks(runtime);
  ok(hash(fs.readFileSync(runtime))===m.files['user/tools/runtime.mjs'].sha256,'TOOLS_NOT_INSTALLED_OR_CHANGED');
  const mod=await import(pathToFileURL(runtime).href);mod.loadProfile(t.TOOLS_ROOT);
  const file=path.join(t.HOME,'.claude/settings.json');noLinks(file);
  const existed=fs.existsSync(file),data=existed?readPrivate(file).toString():null;
  const candidate=json(mod.makeSettings(data?JSON.parse(data):{},t.TOOLS_ROOT,t.SYSTEM_ROOT+'/bin/node'));
  const backup=path.join(t.TOOLS_ROOT,'original-settings.private.json');absent(backup);
  writeNew(backup,json({existed,data,installedHash:hash(candidate)}));
  const tmp=file+'.clashtokyo-new';writeNew(tmp,candidate);fs.renameSync(tmp,file);
  return {hookInstalled:true,credentialsMigrated:false};
}
export function uninstallUser({apply=false}={}) {
  const base=path.join(process.env.HOME||'','.config/clash-tokyo-template');
  if(!apply)return {operation:'uninstall-user',archivesOnly:'template-created browser/apps/config',restoresHookIfUnchanged:true};
  ok(process.getuid()!==0,'MAIN_USER_REQUIRED');noLinks(base);
  const record=JSON.parse(readPrivate(path.join(base,'install-receipt.json'))),t=record.context;
  ok(t.MAIN_UID===process.getuid()&&t.HOME===process.env.HOME,'MAIN_USER_REQUIRED');
  ok(t.BROWSER_ROOT===path.join(base,'browser')&&t.LOGIN_ROOT===path.join(base,'login')&&t.TOOLS_ROOT===path.join(base,'tools'),'USER_RECEIPT_PATH_INVALID');
  for(const [key,name]of [['STATUS_APP','状态'],['BROWSER_APP','浏览器'],['LOGIN_APP','登录']])ok(t[key]===path.join(t.HOME,'Applications',`Clash Tokyo ${name}.app`),'USER_RECEIPT_PATH_INVALID');
  const state=path.join(t.LOGIN_ROOT,'state.json');
  if(fs.existsSync(state))ok(JSON.parse(readPrivate(state)).phase==='closed','END_LOGIN_MODE_BEFORE_UNINSTALL');
  const backup=path.join(t.TOOLS_ROOT,'original-settings.private.json');
  if(fs.existsSync(backup)) {
    const b=JSON.parse(readPrivate(backup)),settings=path.join(t.HOME,'.claude/settings.json');
    ok(hash(readPrivate(settings))===b.installedHash,'CLAUDE_SETTINGS_CHANGED_REVIEW');
  }
  for(const [file,digest]of Object.entries(record.files))ok(hash(fs.readFileSync(file))===digest,'USER_FILE_CHANGED_REVIEW');
  for(const name of ['preflight','indicator']) {try{run('/bin/launchctl',['bootout',`gui/${t.MAIN_UID}/${LABEL_PREFIX}.${name}`]);}catch{}}
  if(fs.existsSync(backup)) {
    const b=JSON.parse(readPrivate(backup)),settings=path.join(t.HOME,'.claude/settings.json');
    if(b.existed){const tmp=settings+'.clashtokyo-restore';writeNew(tmp,b.data);fs.renameSync(tmp,settings);}else fs.unlinkSync(settings);
  }
  for(const [file]of Object.entries(record.files)) if(file.endsWith('.plist')&&path.dirname(file)===path.join(t.HOME,'Library/LaunchAgents'))fs.unlinkSync(file);
  const archive=base+'.disabled-'+Date.now();fs.renameSync(base,archive);
  for(const app of [t.STATUS_APP,t.BROWSER_APP,t.LOGIN_APP])if(fs.existsSync(app))fs.renameSync(app,app+'.disabled');
  return {uninstalled:true,archived:archive,browserDataRetained:true,clashChanged:false};
}
