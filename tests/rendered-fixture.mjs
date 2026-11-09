import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/common.mjs';
import { context,render } from '../src/context.mjs';
const c=JSON.parse(fs.readFileSync(path.join(ROOT,'examples/config.example.json')));
const ctx=context(c,{user:{username:'template',uid:701,homedir:'/Users/template'},serviceUid:480});
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ct-rendered-tests-'));
for(const name of ['tokyo-login-preflight.mjs','claude-codex-route.mjs','claude-tool-network.mjs','tokyo-auth-router.mjs'])
  fs.writeFileSync(path.join(temp,name),render(name,ctx));
for(const f of ['tokyo-startup-policy.mjs','codex-shell-rewrite.py'])fs.copyFileSync(path.join(ROOT,'src',f),path.join(temp,f));
fs.cpSync(path.join(ROOT,'src/vendor'),path.join(temp,'vendor'),{recursive:true});
process.once('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));
export const preflight=await import(pathToFileURL(path.join(temp,'tokyo-login-preflight.mjs')).href);
export const route=await import(pathToFileURL(path.join(temp,'claude-codex-route.mjs')).href);
export const tools=await import(pathToFileURL(path.join(temp,'claude-tool-network.mjs')).href);
export const auth=await import(pathToFileURL(path.join(temp,'tokyo-auth-router.mjs')).href);
