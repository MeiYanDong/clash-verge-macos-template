import fs from 'node:fs';
import path from 'node:path';
import { ROOT,walk,run } from '../src/common.mjs';
for(const dir of ['src','scripts','tests'])for(const f of walk(path.join(ROOT,dir)).filter(f=>f.endsWith('.mjs')))run(process.execPath,['--check',f]);
console.log(JSON.stringify({syntax:'passed',productionNetworkAccess:false}));
