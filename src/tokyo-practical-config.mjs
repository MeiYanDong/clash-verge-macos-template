import { validateProxy } from './schema.mjs';
import { makeJapanShadowConfig } from './claude-japan-chain.mjs';

export const TOKYO_GROUP = 'TOKYO-VERIFIED-CHAIN';
export const LANES = ['bygcloud', 'nexitally'];
export const residenceName = lane => `TOKYO-RESIDENTIAL-${lane.toUpperCase()}`;
export const transitName = lane => `TOKYO-TRANSIT-${lane.toUpperCase()}`;
export const DEFAULT_PORTS = Object.freeze({ gate: 44127, upstream: 44128, controller: 44129,
  bygcloud: 44130, nexitally: 44131 });

export function validatePorts(ports) {
  const values = ['gate', 'upstream', 'controller', ...LANES].map(k => ports?.[k]);
  if (values.some(p => !Number.isInteger(p) || p < 1025 || p > 65535) || new Set(values).size !== 5) {
    throw Error('TOKYO_INVALID_PORTS');
  }
}

export function validateTransit(lane, node) {
  try {
    if (!LANES.includes(lane)) throw Error('LANE');
    validateProxy(node);
  } catch { throw Error('TOKYO_INVALID_TRANSIT'); }
}

// No subscriptions/groups/rules from the airport are inherited. Each candidate
// is a complete transit -> same residential chain, never an airport-only exit.
export function makePracticalConfig({ intake, transits, interfaceName, ports, token }) {
  validatePorts(ports);
  LANES.forEach(lane => validateTransit(lane, transits?.[lane]));
  const base = makeJapanShadowConfig({ intake, transit: transits.nexitally,
    interfaceName, port: ports.upstream, controllerPort: ports.controller, token });
  const residential = base.proxies[1];
  base.proxies = LANES.flatMap(lane => [
    { ...structuredClone(transits[lane]), name: transitName(lane), udp: false },
    { ...residential, name: residenceName(lane), 'dialer-proxy': transitName(lane) }
  ]);
  // Application ingress is loopback-only, not authenticated. This is deliberately
  // a practical explicit-proxy service, NOT an inter-user security boundary.
  // Private probes remain authenticated. Controller access always needs a token.
  base.authentication = [];
  base.listeners = LANES.map(lane => ({ name: `probe-${lane}`, type: 'http',
    listen: '127.0.0.1', port: ports[lane], proxy: residenceName(lane),
    users: [{ username: 'probe', password: token }] }));
  base['proxy-groups'] = [{ name: TOKYO_GROUP, type: 'select',
    proxies: LANES.map(residenceName), 'empty-fallback': 'REJECT', 'disable-udp': true, interval: 0 }];
  // The host's TUN DNS returns fake IPs for airport hostnames. An independent
  // core must resolve its bootstrap servers itself, not dial those fake IPs.
  // Only proxy-server DNS uses physical-interface DoH. Destination DNS uses
  // the residential chain. No OS DNS changes or DNS hijack are installed.
  base.dns = { enable: true, listen: '127.0.0.1:0', ipv6: false,
    'enhanced-mode': 'redir-host', 'use-hosts': false, 'use-system-hosts': false,
    'default-nameserver': ['223.5.5.5', '223.6.6.6'],
    'proxy-server-nameserver': [`https://223.5.5.5/dns-query#${interfaceName}`, `https://223.6.6.6/dns-query#${interfaceName}`],
    nameserver: [`https://1.1.1.1/dns-query#${TOKYO_GROUP}`] };
  base.rules = ['NETWORK,udp,REJECT', `MATCH,${TOKYO_GROUP}`];
  return base;
}
