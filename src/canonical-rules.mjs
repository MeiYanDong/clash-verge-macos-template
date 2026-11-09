// Parse the candidate with the recipient's Mihomo version in an isolated core.
// Every named outbound is REJECT, DNS/TUN/listeners/providers/health probes are
// absent. GeoIP comes only from an existing local database; never download it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { json,requireThat as ok } from './common.mjs';

export async function canonicalRules(candidate,binary,geoDirectory) {
  ok(path.isAbsolute(binary||''),'MIHOMO_BINARY_REQUIRED');
  const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ct-parse-'));
  fs.chmodSync(temp,0o700);
  const socket=path.join(temp,'controller.sock'),secret=crypto.randomBytes(24).toString('hex');
  // macOS sockaddr_un has a short limit; use the system's short temp path.
  if(Buffer.byteLength(socket)>100){fs.rmSync(temp,{recursive:true});throw Error('TEMP_PATH_TOO_LONG');}
  let child;
  try {
    if(candidate.rules.some(r=>r.startsWith('GEOIP,'))) {
      const geo=path.join(geoDirectory||'','Country.mmdb');
      ok(fs.existsSync(geo)&&fs.statSync(geo).isFile(),'LOCAL_GEOIP_DATABASE_REQUIRED');
      fs.copyFileSync(geo,path.join(temp,'Country.mmdb'));
    }
    if(candidate.rules.some(r=>r.startsWith('GEOSITE,'))) {
      const geo=path.join(geoDirectory||'','geosite.dat');
      ok(fs.existsSync(geo)&&fs.statSync(geo).isFile(),'LOCAL_GEOSITE_DATABASE_REQUIRED');
      fs.copyFileSync(geo,path.join(temp,'geosite.dat'));
    }
    const names=[...new Set([...candidate.proxies.map(p=>p.name),...candidate['proxy-groups'].map(p=>p.name)])];
    const config={mode:'rule','mixed-port':0,ipv6:false,'log-level':'silent','allow-lan':false,
      tun:{enable:false},dns:{enable:false},'find-process-mode':'off','geodata-mode':false,'geo-auto-update':false,
      'external-controller-unix':socket,secret,proxies:names.map(name=>({name,type:'reject'})),rules:candidate.rules};
    const file=path.join(temp,'parse.json');fs.writeFileSync(file,json(config),{mode:0o600});
    child=spawn(binary,['-d',temp,'-f',file],{stdio:'ignore',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:temp}});
    let failed=false;child.once('error',()=>{failed=true;});
    const read=()=>new Promise((resolve,reject)=>{
      const req=http.get({socketPath:socket,path:'/rules',headers:{Authorization:'Bearer '+secret}},res=>{
        const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>2**22)req.destroy();else chunks.push(b);});
        res.on('aborted',()=>reject(Error('ABORTED')));res.on('error',reject);
        res.on('end',()=>{try{ok(res.statusCode===200,'RULE_PARSE_STATUS');resolve(JSON.parse(Buffer.concat(chunks)).rules);}catch(e){reject(e);}});
      });req.setTimeout(500,()=>req.destroy());req.on('error',reject);
    });
    for(let i=0;i<40;i++) {
      ok(!failed&&child.exitCode===null&&child.signalCode===null,'MIHOMO_RULE_PARSE_FAILED');
      try{const rules=await read();ok(Array.isArray(rules)&&rules.length===candidate.rules.length,'MIHOMO_RULE_COUNT');return rules;}catch{}
      await delay(100);
    }
    throw Error('MIHOMO_RULE_PARSE_TIMEOUT');
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');
      for(let i=0;i<20&&child.exitCode===null&&child.signalCode===null;i++)await delay(50);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await delay(100);}}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
