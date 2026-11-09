import { validateProxy } from './schema.mjs';
import { isIP } from 'node:net';

export const TRANSIT_NAME = 'CLAUDE-JP-TRANSIT';
export const RESIDENTIAL_NAME = 'CLAUDE-TOKYO-RESIDENTIAL';

export function makeJapanShadowConfig({ intake, transit, interfaceName, port, controllerPort, token }) {
  const validPort = value => Number.isInteger(value) && value > 1024 && value <= 65535;
  if (intake?.protocol !== 'socks5' || !intake.server || /[\s/]/.test(intake.server) ||
      !Number.isInteger(intake.port) || intake.port < 1 || intake.port > 65535 ||
      intake.authentication?.method !== 'username-password' ||
      !intake.authentication.username || !intake.authentication.password ||
      intake.expectedExit?.country !== 'JP' || isIP(intake.expectedExit.ipv4 || '') !== 4) {
    throw new Error('TOKYO_INVALID_PRIVATE_INPUT');
  }
  try { validateProxy(transit); } catch { throw Error('TOKYO_INVALID_TRANSIT'); }
  if (!/^en\d+$/.test(interfaceName || '') || !validPort(port) || !validPort(controllerPort) ||
      port === controllerPort || !/^[a-f0-9]{48}$/.test(token || '')) {
    throw new Error('TOKYO_INVALID_SHADOW_BINDING');
  }
  return {
    mode: 'rule',
    'mixed-port': port,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    authentication: [`probe:${token}`],
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret: token,
    'interface-name': interfaceName,
    ipv6: false,
    'find-process-mode': 'off',
    'log-level': 'silent',
    tun: { enable: false },
    dns: { enable: false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: [
      { ...structuredClone(transit), name: TRANSIT_NAME },
      {
        name: RESIDENTIAL_NAME, type: 'socks5', server: intake.server, port: intake.port,
        username: intake.authentication.username, password: intake.authentication.password,
        udp: false, 'dialer-proxy': TRANSIT_NAME
      }
    ],
    'proxy-groups': [],
    // Unsupported UDP must be rejected explicitly, not allowed to fall through.
    rules: ['NETWORK,udp,REJECT', `MATCH,${RESIDENTIAL_NAME}`]
  };
}
