import { isIP } from 'node:net';
import path from 'node:path';
import { requireThat as ok } from './common.mjs';

export const PROVIDERS = ['bygcloud', 'nexitally'];
export const PORTS = { gate: 44127, upstream: 44128, controller: 44129, bygcloud: 44130, nexitally: 44131 };
const printable = s => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\x00-\x1f\x7f]/.test(s);
export function validateProxy(p) {
  ok(p && printable(p.name) && !/[,()]/.test(p.name) && printable(p.server) && !/[\s/]/.test(p.server), 'INVALID_PROXY');
  ok(Number.isInteger(p.port) && p.port > 0 && p.port <= 65535, 'INVALID_PROXY_PORT');
  ok(['ss','vmess','vless','trojan','anytls','socks5','http'].includes(p.type), 'UNSUPPORTED_PROXY_TYPE');
  ok(!['dialer-proxy','interface-name','routing-mark','proxy'].some(k => Object.hasOwn(p,k)), 'NESTED_ROUTE_REFUSED');
  ok(p['skip-cert-verify'] !== true, 'INSECURE_TLS_REFUSED');
  if (['ss','trojan','anytls'].includes(p.type)) ok(printable(p.password), 'MISSING_PROXY_CREDENTIAL');
  if (['vless','vmess'].includes(p.type)) ok(printable(p.uuid), 'MISSING_PROXY_UUID');
  if (p.type === 'ss') ok(printable(p.cipher), 'MISSING_PROXY_CIPHER');
  return p;
}
export function validateConfig(value, { demo = false } = {}) {
  const c = structuredClone(value);
  ok(c.version === 1 && ['basic','macos'].includes(c.edition), 'CONFIG_VERSION_OR_EDITION');
  ok(typeof c.demo === 'boolean' && (demo || !c.demo), 'EXAMPLE_REQUIRES_DEMO_FLAG');
  ok(Array.isArray(c.providers) && c.providers.length === 2 && c.providers.every((p,i)=>p.id === PROVIDERS[i]), 'TWO_PROVIDER_SLOTS_REQUIRED');
  for (const p of c.providers) {
    ok(printable(p.label) && Array.isArray(p.nodes) && p.nodes.length > 0, 'PROVIDER_INPUT_REQUIRED');
    p.nodes.forEach(validateProxy);
    ok(new Set(p.nodes.map(n=>n.name)).size === p.nodes.length, 'DUPLICATE_NODE_NAME');
    if (p.subscriptionUrl) {
      const u = new URL(p.subscriptionUrl);
      ok(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'HTTPS_SUBSCRIPTION_REQUIRED');
    }
    for (const region of ['us','hk','jp']) {
      ok(printable(p.filters?.[region]) && p.filters[region].length <= 256, 'REGION_FILTER_REQUIRED');
      const rx = new RegExp(p.filters[region]);
      ok(p.nodes.some(n=>rx.test(n.name)), 'REGION_POOL_EMPTY');
    }
    ok(p.nodes.some(n=>n.name === c.tokyo?.transitNames?.[p.id] && new RegExp(p.filters.jp).test(n.name)), 'JAPAN_TRANSIT_NOT_SELECTED');
  }
  for (const region of ['us','tokyo']) {
    const r = c.residential?.[region];
    validateProxy({ ...r, name: 'Residential', type: 'socks5' });
    ok(printable(r.username) && printable(r.password) && isIP(r.expectedIp) === 4, 'RESIDENTIAL_INPUT_REQUIRED');
    if (!demo) ok(!/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(r.expectedIp) && !r.server.endsWith('.invalid'), 'EXAMPLE_NOT_DEPLOYABLE');
  }
  ok(Number.isInteger(c.main?.port) && c.main.port >= 1025 && c.main.port <= 65535, 'MAIN_PORT_REQUIRED');
  c.tokyo.ports ??= { ...PORTS };
  const ports = ['gate','upstream','controller',...PROVIDERS].map(k=>c.tokyo.ports[k]);
  ok(ports.every(n=>Number.isInteger(n) && n>=1025 && n<=65535) && new Set([...ports,c.main.port]).size === 6, 'PORT_COLLISION');
  c.features ??= { browser: false, login: false, tools: false, codex: false };
  for (const k of ['browser','login','tools','codex']) ok(typeof c.features[k] === 'boolean', 'FEATURE_FLAG_INVALID');
  ok(!c.features.login || c.features.browser, 'LOGIN_REQUIRES_BROWSER');
  ok(!c.features.codex || c.features.tools, 'CODEX_REQUIRES_TOOLS');
  c.directDomains ??= []; c.extraResidentialDomains ??= [];
  for (const list of [c.directDomains,c.extraResidentialDomains]) {
    ok(Array.isArray(list) && list.every(d=>typeof d==='string' && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(d)), 'DOMAIN_LIST_INVALID');
  }
  if (c.features.tools) {
    ok(Array.isArray(c.tools?.sshBlocks), 'SSH_BLOCKS_REQUIRED');
    for (const key of ['awsBinary', ...(c.features.codex ? ['codexBinary'] : [])]) {
      ok(typeof c.tools[key] === 'string' && path.isAbsolute(c.tools[key]) && !/[\r\n'"`$\\]/.test(c.tools[key]), 'TOOL_PATH_INVALID');
    }
  }
  return c;
}
