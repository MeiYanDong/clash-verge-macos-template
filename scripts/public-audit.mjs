import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT,walk,requireThat as ok } from '../src/common.mjs';

export const PUBLIC_ROOTS=['README.md','LICENSE-NOTICE.md','THIRD-PARTY-NOTICES.md','package.json','.gitignore','PUBLIC-FILES.json',
  'src','templates','scripts','tests','docs','examples','.github'];
export function publicFiles(root=ROOT) {
  return PUBLIC_ROOTS.flatMap(p=>{
    const file=path.join(root,p);if(!fs.existsSync(file))return [];
    ok(!fs.lstatSync(file).isSymbolicLink(),'PUBLIC_SYMLINK');
    return fs.statSync(file).isDirectory()?walk(file):[file];
  }).map(p=>path.relative(root,p)).sort();
}
const safeIP=ip=>['0.0.0.0','255.255.255.255','1.1.1.1','223.5.5.5','223.6.6.6'].includes(ip)||
  /^(127\.|10\.|192\.168\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.18\.)/.test(ip)||/^172\.(1[6-9]|2\d|3[01])\./.test(ip);
export function inspectText(text) {
  const issues=[];
  if(/\/Users\/(?!Shared(?:\/|\b)|template(?:\/|\b)|example(?:\/|\b))[\p{L}\p{N}_.-]+/u.test(text))issues.push('PERSONAL_HOME_PATH');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))issues.push('PRIVATE_KEY');
  if(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text))issues.push('ACCESS_TOKEN');
  if(/https?:\/\/[^\s'"`<>]+\?[^\s'"`<>]*(?:token|key|auth|subscription|urk|password)=/i.test(text))issues.push('CREDENTIAL_URL');
  if(/https?:\/\/[^\s'"`<>?]+\?[A-Za-z0-9%+/_=-]{48,}/.test(text))issues.push('OPAQUE_SUBSCRIPTION_URL');
  for(const m of text.matchAll(/(?:password|username|uuid|apiKey|accessToken|clientSecret)\s*['"]?\s*[:=]\s*['"]([^'"\r\n]+)['"]/g)) {
    if(!/^(?:EXAMPLE_ONLY|fixture|probe|operator|test|template|secret|dummy|password|redacted|invalid|[a-z]|@@[A-Z_]+@@)$/.test(m[1]) && !m[1].startsWith('${'))issues.push('LITERAL_CREDENTIAL_REVIEW');
  }
  for(const m of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g))if(!safeIP(m[0]))issues.push('UNREVIEWED_PUBLIC_IP');
  if(/\b(?:i-[a-f0-9]{8,17}|arn:aws:[a-z0-9]+:[a-z0-9-]*:\d{12}:[^\s"']+|[A-Z0-9._%+-]+@(?!example\.(?:com|invalid)\b)[A-Z0-9.-]+\.[A-Z]{2,})\b/i.test(text))issues.push('PERSONAL_INFRASTRUCTURE_OR_EMAIL');
  return [...new Set(issues)];
}
export function audit(root=ROOT) {
  const files=publicFiles(root),issues=[];
  for(const f of files) {
    if(/(?:^|\/)(?:build|dist|\.private|node_modules|__pycache__)(?:\/|$)|\.private\.|\.pyc$|\.log$/.test(f))issues.push({file:f,kind:'PRIVATE_ARTIFACT'});
    const b=fs.readFileSync(path.join(root,f));if(b.includes(0))issues.push({file:f,kind:'BINARY_FILE'});
    // Retain this upstream copyright attribution. It is not user data.
    const text=b.toString('utf8').replaceAll('ezioup' + '@' + 'alumni.uchicago.edu','upstream@example.invalid');
    for(const kind of inspectText(text))issues.push({file:f,kind});
  }
  return {okay:issues.length===0,files:files.length,issues};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const r=audit();console.log(JSON.stringify(r,null,2));if(!r.okay)process.exitCode=1;}
