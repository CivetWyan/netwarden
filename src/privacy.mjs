import os from 'node:os';

export function uploadView(value, store, privacy = 'network') {
  const clean = input => {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([key]) => !/^(apiKey|authorization|password|passwd|secret|token|mac|hostname|username|env|environment)$/i.test(key)).map(([key, v]) => [key, clean(v)]));
    if (typeof input !== 'string') return input;
    let text = store.redact({ value: input }).value;
    for (const secret of [os.hostname(), os.userInfo().username, os.homedir()].sort((a,b) => b.length - a.length)) if (secret?.length > 2) text = text.split(secret).join('[LOCAL_ID]');
    text = text.replace(/\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b/gi, '[MAC]');
    text = text.replace(/(["']?(?:password|passwd|authorization|api[_-]?key|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1[CREDENTIAL]');
    if (privacy === 'minimal') text = text.replace(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, '[PRIVATE_IP]');
    return text;
  };
  return clean(value);
}
