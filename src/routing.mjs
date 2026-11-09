import { validateConfig, PROVIDERS } from './schema.mjs';
import fs from 'node:fs';
const domainPolicy=JSON.parse(fs.readFileSync(new URL('./domain-policy.json',import.meta.url)));

export const N = { daily: '日常上网', hk: '双机场香港', us: '双机场美国', front: '美国中转',
  usGroup: 'ChatGPT · 美国静态住宅', usExit: 'US-RESIDENTIAL',
  tokyo: 'Claude · 东京静态住宅', gate: '🗼 Claude 东京专线（受控入口）' };
export const CLAUDE_DOMAINS = [...new Set([...domainPolicy.claude,'claude.ai','anthropic.com','claude.com','claudeusercontent.com'])];
export const US_DOMAINS = [...new Set([...domainPolicy.us,'openai.com','chatgpt.com','oaistatic.com','oaiusercontent.com','chat.com',
  'grok.com','x.ai','grokusercontent.com','grokipedia.com','spacex.ai',
  'x.com','twitter.com','twimg.com','t.co','telegram.org','t.me','telegram.me','reddit.com','redd.it','redditstatic.com','redditmedia.com',
  'linkedin.com','licdn.com','stripe.com','stripe.network','stripecdn.com','sentry.io','intercom.io','intercomcdn.com'])];
export const LOCAL_CIDRS = ['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16','::1/128','fc00::/7','fe80::/10'];
const segment = '([^. /][^/]*| [^/]*|[.][^./][^/]*|[.][.][^/]+)';
const appPattern = name => `^/Applications/${name}[.]app/Contents/${segment}(/${segment})*$`;
export function appRules(name, target) {
  return processRules(appPattern(name),target);
}
export function processRules(pattern, target) {
  const local = ['(DOMAIN-SUFFIX,localhost)','(DOMAIN-SUFFIX,local)', ...LOCAL_CIDRS.map(c=>`(${c.includes(':')?'IP-CIDR6':'IP-CIDR'},${c},no-resolve)`)];
  const condition = `(PROCESS-PATH-REGEX,${pattern}),(NOT,((OR,(${local.join(',')}))))`;
  return ['udp','tcp'].map(n=>`AND,(${condition},(NETWORK,${n})),${n==='udp'?'REJECT':target}`);
}
const health = { url: 'https://www.gstatic.com/generate_204', interval: 60, timeout: 5000, lazy: false, 'expected-status': 204 };
const selector = (name,proxies) => ({ name,type:'select',proxies,'empty-fallback':'REJECT' });
const domainBlock = (domains,target) => [
  `AND,((OR,(${domains.map(d=>`(DOMAIN-SUFFIX,${d})`).join(',')})),(NETWORK,udp)),REJECT`,
  ...domains.map(d=>`DOMAIN-SUFFIX,${d},${target}`)
];
export function buildRouting(input, options = {}) {
  const c = validateConfig(input, options);
  const providers = Object.fromEntries(c.providers.map(p=>[p.id, {
    type: p.subscriptionUrl ? 'http' : 'inline', ...(p.subscriptionUrl ? {
      url:p.subscriptionUrl,path:`./proxy_providers/template-${p.id}.yaml`,interval:3600,proxy:'DIRECT','size-limit':8388608
    } : {}), payload:structuredClone(p.nodes), override:{'additional-prefix':`[${p.id}] `},
    'health-check':{ enable:true, ...health }
  }]));
  const groups = [selector(N.daily,[N.hk]), selector(N.usGroup,[N.usExit]), selector(N.front,[N.us])];
  for (const region of ['us','hk']) for (const p of c.providers) groups.push({
    name:`${p.id}-${region}`,type:'url-test',use:[p.id],filter:p.filters[region],
    ...health,tolerance:150,'empty-fallback':'REJECT',hidden:true
  });
  groups.push({name:N.us,type:'fallback',proxies:PROVIDERS.map(p=>`${p}-us`),...health,'empty-fallback':'REJECT'},
    {name:N.hk,type:'url-test',proxies:PROVIDERS.map(p=>`${p}-hk`),...health,tolerance:150,'empty-fallback':'REJECT'});
  const {expectedIp:_,...us}=c.residential.us;
  const proxies=[{...us,name:N.usExit,type:'socks5',udp:false,'dialer-proxy':N.front}];
  if(c.edition==='macos') {
    proxies.push({name:N.gate,type:'http',server:'127.0.0.1',port:c.tokyo.ports.gate});
    groups.push(selector(N.tokyo,[N.gate]));
  } else {
    const {expectedIp:__,...jp}=c.residential.tokyo;
    for(const p of c.providers) {
      const transit=structuredClone(p.nodes.find(n=>n.name===c.tokyo.transitNames[p.id]));
      transit.name=`JP-TRANSIT-${p.id}`; proxies.push(transit,
        {...jp,name:`JP-RESIDENTIAL-${p.id}`,type:'socks5',udp:false,'dialer-proxy':transit.name});
    }
    groups.push({name:N.tokyo,type:'fallback',proxies:PROVIDERS.map(p=>`JP-RESIDENTIAL-${p}`),...health,'empty-fallback':'REJECT','disable-udp':true});
  }
  // App ownership precedes common Stripe/Intercom routes. Child tools need their
  // own optional wrapper; a domain or parent-process rule is not a process tree.
  const embedded='^/Users/[^/]+/Library/Application Support/Claude/claude-code/[0-9]+[.][0-9]+[.][0-9]+/[a-f0-9]{12}/claude[.]app/Contents/MacOS/claude$';
  const cli='^/Users/[^/]+/[.]local/share/claude/versions/[0-9]+[.][0-9]+[.][0-9]+$';
  const rules=[...appRules('Claude',N.tokyo),...processRules(embedded,N.tokyo),...processRules(cli,N.tokyo),...appRules('Grok Bot',N.usGroup),
    ...domainBlock(CLAUDE_DOMAINS,N.tokyo),...domainBlock([...new Set([...US_DOMAINS,...c.extraResidentialDomains])],N.usGroup),
    ...domainPolicy.youtube.map(d=>`DOMAIN-SUFFIX,${d},${N.daily}`),
    ...c.directDomains.map(d=>`DOMAIN,${d},DIRECT`),
    'DOMAIN-SUFFIX,localhost,DIRECT','DOMAIN-SUFFIX,local,DIRECT',
    ...LOCAL_CIDRS.map(r=>`${r.includes(':')?'IP-CIDR6':'IP-CIDR'},${r},DIRECT,no-resolve`),
    'GEOSITE,CN,DIRECT','GEOIP,CN,DIRECT,no-resolve',`MATCH,${N.daily}`];
  return {mode:'rule','mixed-port':c.main.port,'allow-lan':false,'bind-address':'127.0.0.1',
    'find-process-mode':'strict',ipv6:false,'log-level':'info',
    profile:{'store-selected':false,'store-fake-ip':true},
    tun:{enable:true,stack:'mixed','auto-route':true,'auto-detect-interface':true,'dns-hijack':['any:53']},
    dns:{enable:true,listen:'127.0.0.1:0',ipv6:false,'enhanced-mode':'fake-ip','fake-ip-range':'198.18.0.1/16',
      'default-nameserver':['223.5.5.5','223.6.6.6'],'proxy-server-nameserver':['https://223.5.5.5/dns-query'],
      nameserver:['https://1.1.1.1/dns-query'], 'fake-ip-filter':['*.local','localhost']},
    proxies,'proxy-providers':providers,'proxy-groups':groups,rules};
}
export function gatewaySettings(c, uid) {
  const r=c.residential.tokyo;
  return {uid,ports:c.tokyo.ports,intake:{protocol:'socks5',server:r.server,port:r.port,
    authentication:{method:'username-password',username:r.username,password:r.password},expectedExit:{country:'JP',ipv4:r.expectedIp}},
    transits:Object.fromEntries(c.providers.map(p=>[p.id,structuredClone(p.nodes.find(n=>n.name===c.tokyo.transitNames[p.id]))]))};
}
