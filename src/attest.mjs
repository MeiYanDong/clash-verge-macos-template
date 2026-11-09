import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { hash, requireThat as ok, readYaml } from './common.mjs';
import { N } from './routing.mjs';
import { canonicalRules } from './canonical-rules.mjs';
import path from 'node:path';

export const rulesDigest = rules => hash(JSON.stringify(rules.map(({type,payload,proxy})=>({type,payload,proxy}))));
export function readController(socketPath, route) {
  ok(['/configs','/proxies','/rules','/version'].includes(route),'READ_ONLY_CONTROLLER_ROUTE');
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:route,method:'GET'},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>8*1024**2)req.destroy();else chunks.push(b);});
      res.on('error',()=>reject(Error('CONTROLLER_UNAVAILABLE')));
      res.on('aborted',()=>reject(Error('CONTROLLER_ABORTED')));
      res.on('end',()=>{try{ok(res.statusCode===200,'CONTROLLER_STATUS');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('CONTROLLER_INVALID'));}});
    });
    req.setTimeout(3000,()=>req.destroy());req.on('error',()=>reject(Error('CONTROLLER_UNAVAILABLE')));req.end();
  });
}
export function compareRendered(expected, rendered) {
  for(const k of ['rules','proxies','proxy-groups','proxy-providers','find-process-mode']) assert.deepEqual(rendered[k],expected[k],'RENDERED_PROFILE_NOT_CANDIDATE');
  ok(rendered.mode==='rule' && rendered.tun?.enable===true && rendered['mixed-port']===expected['mixed-port'],'RENDERED_MODE_CHANGED');
}
export function compareLive(expected, live, referenceRules) {
  const {config,proxies,rules}=live, group=proxies?.[N.tokyo];
  ok(config?.mode==='rule' && config.tun?.enable===true && config['mixed-port']===expected['mixed-port'],'LIVE_MODE_CHANGED');
  ok(Array.isArray(rules) && rules.length===expected.rules.length,'LIVE_RULE_COUNT');
  ok(Array.isArray(referenceRules)&&rulesDigest(rules)===rulesDigest(referenceRules),'LIVE_RULE_CONTENT_CHANGED');
  ok(group?.type==='Selector' && group.now===N.gate && JSON.stringify(group.all)===JSON.stringify([N.gate]) && proxies[N.gate]?.type==='Http','LIVE_TOKYO_ROUTE_CHANGED');
  const us=proxies[N.usGroup];
  ok(us?.now===N.usExit && JSON.stringify(us.all)===JSON.stringify([N.usExit]),'LIVE_US_ROUTE_CHANGED');
  return rulesDigest(rules);
}
export async function bindLive(expected,tokens,binary) {
  const reference=await canonicalRules(expected,binary,path.dirname(tokens.RENDERED_CONFIG));
  const before=fs.readFileSync(tokens.RENDERED_CONFIG);
  compareRendered(expected,readYaml(tokens.RENDERED_CONFIG));
  const [config,p,r]=await Promise.all(['/configs','/proxies','/rules'].map(route=>readController(tokens.MAIN_SOCKET,route)));
  ok(hash(fs.readFileSync(tokens.RENDERED_CONFIG))===hash(before),'PROFILE_CHANGED_DURING_BIND');
  return {rulesHash:compareLive(expected,{config,proxies:p.proxies,rules:r.rules},reference),boundAt:new Date().toISOString()};
}
