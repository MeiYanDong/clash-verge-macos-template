import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ROOT, SYSTEM_ROOT, SERVICE_USER, requireThat as ok, run } from './common.mjs';

export function context(c, { user = os.userInfo(), serviceUid = 499, renderedConfig, mainSocket } = {}) {
  ok(/^[a-z_][a-z0-9_-]{0,30}$/i.test(user.username) && user.uid >= 501 && user.uid <= 2147483647, 'MAIN_IDENTITY_INVALID');
  const home = user.homedir;
  ok(path.isAbsolute(home) && !/[\r\n'"`$\\<>]|(?:^|\/)\.\.(?:\/|$)/.test(home), 'HOME_PATH_UNSUPPORTED');
  ok(Number.isInteger(serviceUid) && serviceUid >= 400 && serviceUid < 500 && serviceUid !== user.uid, 'SERVICE_UID_INVALID');
  const base = path.join(home,'.config/clash-tokyo-template');
  const app = name => path.join(home,'Applications',`Clash Tokyo ${name}.app`);
  const tokens = {
    HOME:home,USER:user.username,MAIN_UID:user.uid,SERVICE_UID:serviceUid,SERVICE_USER,
    SYSTEM_ROOT,MAIN_SOCKET:mainSocket ?? `/var/run/clash-verge-service/users/${user.uid}/verge-mihomo.sock`,
    RENDERED_CONFIG:renderedConfig ?? path.join(home,'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml'),
    READINESS_FILE:`/Users/Shared/ClashTokyoTemplate-${user.uid}/readiness.json`,
    BROWSER_ROOT:path.join(base,'browser'),BROWSER_DATA:path.join(base,'chrome-data'),
    BROWSER_APP:app('浏览器'),BROWSER_ENTRY:path.join(home,'Desktop/Clash Tokyo 浏览器.app'),
    STATUS_APP:app('状态'),LOGIN_ROOT:path.join(base,'login'),LOGIN_APP:app('登录'),TOOLS_ROOT:path.join(base,'tools'),
    TOKYO_IP:c.residential.tokyo.expectedIp,US_IP:c.residential.us.expectedIp,GATE_PORT:c.tokyo.ports.gate,MAIN_PORT:c.main.port,
    AWS_BINARY:c.tools?.awsBinary ?? '/opt/homebrew/bin/aws',
    CODEX_BINARY:c.tools?.codexBinary ?? '/Applications/Codex.app/Contents/Resources/codex'
  };
  for (const value of Object.values(tokens)) ok(!/[\r\n'"`$\\<>]/.test(String(value)), 'TEMPLATE_VALUE_UNSAFE');
  return tokens;
}
export function chooseServiceUid(upgrade = false) {
  if(upgrade) {
    const file=SYSTEM_ROOT+'/installation.json',s=fs.lstatSync(file);
    ok(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'INSTALLED_RECEIPT_UNSAFE');
    const m=JSON.parse(fs.readFileSync(file));
    ok(m.version===1&&m.context?.USER===os.userInfo().username&&m.context?.MAIN_UID===process.getuid()&&m.context?.SERVICE_USER===SERVICE_USER,'UPGRADE_IDENTITY_CHANGED');
    return m.context.SERVICE_UID;
  }
  const users=run('/usr/bin/dscl',['.','-list','/Users','UniqueID']);
  const groups=run('/usr/bin/dscl',['.','-list','/Groups','PrimaryGroupID']);
  ok(![users,groups].some(s=>s.split('\n').some(l=>l.trim().startsWith(SERVICE_USER+' '))), 'SERVICE_ACCOUNT_ALREADY_EXISTS');
  const occupied=new Set([...users.matchAll(/\s(\d+)\s*$/gm),...groups.matchAll(/\s(\d+)\s*$/gm)].map(m=>Number(m[1])));
  for(let n=499;n>=400;n--) if(!occupied.has(n)) return n;
  throw Error('NO_FREE_SERVICE_UID');
}
export function render(name, tokens) {
  const text=fs.readFileSync(path.join(ROOT,'templates',name+'.in'),'utf8');
  const out=text.replace(/@@([A-Z_]+)@@/g, (_,k)=>{ok(Object.hasOwn(tokens,k),'UNKNOWN_TEMPLATE_TOKEN'); return String(tokens[k]);});
  ok(!/@@[A-Z_]+@@/.test(out),'UNRESOLVED_TEMPLATE_TOKEN'); return out;
}
