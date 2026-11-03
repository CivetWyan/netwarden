import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from '../src/store.mjs';
process.env.ELECTRON_CACHE = path.join(ROOT, '.cache', 'electron');
process.env.electron_config_cache = process.env.ELECTRON_CACHE;
console.log(`Electron 运行时：${createRequire(import.meta.url)('electron')}`);
