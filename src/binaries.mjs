import { run,requireThat as ok } from './common.mjs';
export function linkedLibraries(output) {
  return output.split('\n').slice(1).map(l=>l.trim().split(' (compatibility version')[0]).filter(Boolean);
}
export function assertPortableLinks(output) {
  const libraries=linkedLibraries(output);ok(libraries.length>0,'MACHO_INSPECTION_FAILED');
  ok(libraries.every(p=>p.startsWith('/usr/lib/')||p.startsWith('/System/Library/')),'STANDALONE_RUNTIME_REQUIRED');
}
export function checkPortableBinary(binary) {
  assertPortableLinks(run('/usr/bin/otool',['-L',binary]));
}
