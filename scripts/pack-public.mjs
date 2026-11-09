import fs from 'node:fs';
import path from 'node:path';
import { audit,publicFiles } from './public-audit.mjs';
import { ROOT,json,hash,writeNew,createPrivateDirectory,run,requireThat as ok } from '../src/common.mjs';
const result=audit();ok(result.okay,'PUBLIC_AUDIT_FAILED');
const files=publicFiles();
const declared=JSON.parse(fs.readFileSync(path.join(ROOT,'PUBLIC-FILES.json')));
ok(JSON.stringify(files.filter(f=>f!=='PUBLIC-FILES.json'))===JSON.stringify(declared.files),'PUBLIC_ALLOWLIST_CHANGED');
const release='clash-verge-macos-template-0.1.0';
const directory=path.join(ROOT,'dist',release);createPrivateDirectory(directory);
for(const file of files)writeNew(path.join(directory,file),fs.readFileSync(path.join(ROOT,file)),0o644);
const receipt={version:'0.1.0',files:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(directory,f)))])),
  secretsIncluded:false,installed:false,remotePublished:false};
writeNew(path.join(ROOT,'dist',release+'.manifest.json'),json(receipt));
const zip=path.join(ROOT,'dist',release+'.zip');ok(!fs.existsSync(zip),'ARCHIVE_EXISTS');
if(process.platform==='darwin')run('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',directory,zip]);
else run('/usr/bin/zip',['-qr',zip,release],{cwd:path.dirname(directory)});
console.log(json({archive:path.relative(ROOT,zip),sha256:hash(fs.readFileSync(zip)),files:files.length,privateDirectoriesIncluded:false}));
