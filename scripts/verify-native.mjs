// Explicit, local-only verification. Does not install or start the service/App.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyPackage } from '../src/install.mjs';
import { canonicalRules } from '../src/canonical-rules.mjs';
import { buildRouting,gatewaySettings } from '../src/routing.mjs';
import { makePracticalConfig } from '../src/tokyo-practical-config.mjs';
import { json,run,walk,requireThat as ok } from '../src/common.mjs';
const [directory,geoDirectory,...extra]=process.argv.slice(2);
ok(directory&&geoDirectory&&!extra.length,'PACKAGE_AND_GEO_DIRECTORY_REQUIRED');
const {dir,m,c}=verifyPackage(directory);ok(m.demo&&m.compiled,'COMPILED_DEMO_PACKAGE_REQUIRED');
const node=path.join(dir,'system/bin/node'),mihomo=path.join(dir,'system/bin/verge-mihomo');
const nativeVersion=run(node,['--version']).trim();
for(const file of walk(dir).filter(f=>f.endsWith('.mjs')))run(node,['--check',file]);
run('/usr/sbin/visudo',['-cf',path.join(dir,'sudoers')]);
for(const file of walk(dir).filter(f=>f.endsWith('.plist')))run('/usr/bin/plutil',['-lint',file]);
const status=run(path.join(dir,'apps/status/Contents/MacOS/tokyo-status-view'),['--self-test']).trim();
ok(status==='STATUS_VIEW_SELF_TESTS_PASSED 26','NATIVE_STATUS_SELF_TEST_FAILED');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ct-native-'));fs.chmodSync(temp,0o700);
let ruleCount;
try {
  for(const name of ['Country.mmdb','geosite.dat']){const geo=path.join(geoDirectory,name);ok(fs.existsSync(geo),'LOCAL_GEO_DATABASE_REQUIRED');fs.copyFileSync(geo,path.join(temp,name));}
  const configs=[buildRouting(c,{demo:true}),buildRouting({...c,edition:'basic'},{demo:true}),
    makePracticalConfig({...gatewaySettings(c,process.getuid()),interfaceName:'en0',token:'a'.repeat(48)})];
  for(const [i,config]of configs.entries()) {
    const file=path.join(temp,'input-'+i+'.json');fs.writeFileSync(file,json(config),{mode:0o600});
    run(mihomo,['-t','-d',temp,'-f',file]);
  }
  ruleCount=(await canonicalRules(configs[0],mihomo,geoDirectory)).length;
} finally {fs.rmSync(temp,{recursive:true,force:true});}
console.log(json({nativeVersion,renderedScripts:'syntax-passed',launchd:'syntax-passed',sudoers:'syntax-passed',
  nativeIndicatorTests:26,mihomoConfigs:3,isolatedRuleCount:ruleCount,
  installed:false,productionControllerAccess:false,tunStarted:false,credentialsUsed:'synthetic-only'}));
