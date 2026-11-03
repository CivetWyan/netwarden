// Wait for the local Ollama server and load the model once, so the first outage decision is not slowed
// by a cold start. Configure with OLLAMA_HOST (host:port) and NETWARDEN_MODEL (model name in Ollama).
const base = `http://${process.env.OLLAMA_HOST || '127.0.0.1:11434'}`;
const model = process.env.NETWARDEN_MODEL || 'netwarden-qwen';
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  try { ready = (await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) throw Error(`Local model server at ${base} did not become ready`);
const tags = await (await fetch(`${base}/api/tags`)).json();
if (!tags.models?.some(m => m.name === model || m.name === `${model}:latest`)) {
  console.log(`Model ${model} is not registered yet; create it first (see deploy/README.md).`);
} else {
  const r = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: -1, stream: false }), signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw Error(`Model warm-up HTTP ${r.status}`);
  await r.json(); console.log(`${model} is loaded and resident`);
}
