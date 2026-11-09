import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPortableLinks} from '../src/binaries.mjs';
test('standalone runtime depends only on system libraries',()=>{
  assert.doesNotThrow(()=>assertPortableLinks('node:\n /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n /System/Library/Frameworks/Security.framework/Security (compatibility version 1.0.0)'));
});
test('Homebrew/rpath dependency is refused before creating a deployable package',()=>{
  for(const lib of ['@rpath/libnode.dylib','/opt/homebrew/opt/example/lib/example.dylib'])assert.throws(()=>assertPortableLinks(`node:\n ${lib} (compatibility version 1.0.0)`),/STANDALONE_RUNTIME_REQUIRED/);
  assert.throws(()=>assertPortableLinks(''),/INSPECTION_FAILED/);
});
