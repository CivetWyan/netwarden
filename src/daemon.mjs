import path from 'node:path';
import { Engine } from './engine.mjs';
import { ROOT } from './store.mjs';
import { startWeb } from './web.mjs';
import { acquireLock } from './lock.mjs';
const dir = path.resolve(process.env.NETWORK_REPAIR_HOME || path.join(ROOT, 'runtime'));
const release = acquireLock(dir); const engine = new Engine({ dir });
let closing = false; let web;
async function close() { if (closing) return; closing = true; await web?.close(); await engine.close(); release(); }
process.on('SIGINT', () => close().then(() => process.exit(0)));
process.on('SIGTERM', () => close().then(() => process.exit(0)));
try {
  if (process.argv.includes('--once')) {
    const result = await engine.sensor.sample({ fresh: true }); console.log(JSON.stringify(result, null, 2)); await close();
  } else {
    if (process.env.NETWORK_WEB_HOST) web = await startWeb(engine, { host: process.env.NETWORK_WEB_HOST, port: Number(process.env.NETWORK_WEB_PORT || 8088) });
    engine.on('event', e => console.log(`${e.at} [${e.type}] ${e.message}`)); await engine.start();
  }
} catch (e) { console.error(e.message); await close(); process.exitCode = 1; }
