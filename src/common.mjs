import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SYSTEM_ROOT = '/Library/Application Support/ClashTokyoTemplate';
export const SERVICE_USER = '_cttokyo';
export const SERVICE_LABEL = 'local.clashtokyo.template.gateway';
export const LABEL_PREFIX = 'local.clashtokyo.template';
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const json = x => JSON.stringify(x, null, 2) + '\n';
export const fail = code => { throw Error(code); };
export const requireThat = (okay, code) => { if (!okay) fail(code); };
export const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
export const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function noLinks(filename) {
  for (let p = path.resolve(filename); p !== path.dirname(p); p = path.dirname(p)) {
    try { requireThat(!fs.lstatSync(p).isSymbolicLink(), 'SYMLINK_REFUSED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
export function readPrivate(filename, uid = process.getuid()) {
  noLinks(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    requireThat(s.isFile() && s.uid === uid && !(s.mode & 0o077) && s.nlink === 1 && s.size < 16 * 1024 ** 2, 'PRIVATE_INPUT_UNSAFE');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function createPrivateDirectory(directory) {
  noLinks(directory);
  requireThat(!fs.existsSync(directory), 'OUTPUT_ALREADY_EXISTS');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
export function writeNew(filename, data, mode = 0o600) {
  noLinks(filename); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, data, { flag: 'wx', mode });
}
export function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 ** 2,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }, ...options });
  requireThat(result.status === 0 && !result.error, 'COMMAND_FAILED_REDACTED');
  return result.stdout;
}
export function walk(directory) {
  const out = [];
  for (const d of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = path.join(directory, d.name);
    requireThat(!d.isSymbolicLink(), 'SYMLINK_REFUSED');
    if (d.isDirectory()) out.push(...walk(p)); else if (d.isFile()) out.push(p); else fail('SPECIAL_FILE_REFUSED');
  }
  return out;
}
// JSON is also valid YAML. Ruby is used only to READ a user-supplied Clash export;
// safe_load rejects arbitrary YAML objects. Nothing is evaluated as shell code.
export function readYaml(filename) {
  return JSON.parse(run('/usr/bin/ruby', ['-e',
    'require "yaml"; require "json"; STDOUT.write(JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false)))', filename]));
}
