export function completionUrl(base) {
  const clean = base.replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return clean;
  return `${clean}${/\/v\d+$/.test(clean) || /\/openai$/.test(clean) ? '' : '/v1'}/chat/completions`;
}
export class Model {
  constructor(store, fetcher = fetch) { this.store = store; this.fetcher = fetcher; this.tails = { local: Promise.resolve(), online: Promise.resolve() }; }
  async complete(messages, tools, signal, { track = 'local', structured = false } = {}) {
    // One inference request at a time, including specialist agents. Avoid multiplying KV cache on a small local model.
    if (!Object.hasOwn(this.tails, track)) throw Error('未知模型轨道');
    const previous = this.tails[track]; let release; this.tails[track] = new Promise(resolve => { release = resolve; });
    try {
      await previous; signal?.throwIfAborted();
      const c = track === 'online' ? this.store.config.onlineModel : this.store.config.model;
      if (!c.name) throw Error('请先配置模型名称、URL 和 API Key（本地服务可留空）');
      const timeoutSignal = AbortSignal.timeout(c.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const body = { model: c.name, messages, temperature: 0.15, max_tokens: c.maxTokens, stream: false };
      if (c.reasoningEffort) body.reasoning_effort = c.reasoningEffort;
      if (structured) body.response_format = { type: 'json_object' };
      if (new URL(c.baseUrl).hostname === 'api.deepseek.com') body.thinking = { type: 'disabled' };
      if (tools?.length && c.mode === 'native') { body.tools = tools; body.tool_choice = 'auto'; }
      let response;
      try { response = await this.fetcher(completionUrl(c.baseUrl), { method: 'POST', signal: requestSignal, redirect: 'error', headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) }, body: JSON.stringify(body) }); }
      catch (e) {
        // "fetch failed" alone is undiagnosable; surface the underlying cause (DNS, TLS, refused, timeout).
        if (signal?.aborted) throw e;
        const cause = e.cause ? `${e.cause.code || ''} ${e.cause.message || ''}`.trim() : '';
        throw Error(`${e.name === 'TimeoutError' ? `模型请求超时（${c.timeoutMs}ms）` : e.message}${cause ? `：${cause}` : ''}（${track}，${new URL(c.baseUrl).host}）`);
      }
      // Keep response bodies bounded, including servers that send an unbounded stream accidentally.
      const reader = response.body?.getReader(); let raw = ''; let bytes = 0; const decoder = new TextDecoder();
      if (!reader) throw Error('模型返回空响应体');
      try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw Error('模型响应超过 2MB'); } raw += decoder.decode(value, { stream: true }); } raw += decoder.decode(); } finally { reader.releaseLock(); }
      if (!response.ok) throw Error(`模型 HTTP ${response.status}: ${raw.slice(0, 800)}`);
      let data; try { data = JSON.parse(raw); } catch { throw Error('模型未返回有效的 OpenAI Chat Completions JSON'); }
      const choice = data.choices?.[0]; if (!choice?.message) throw Error('模型响应缺少 choices[0].message');
      if (choice.finish_reason === 'length') throw Error('模型输出被截断；请提高输出 token 或缩短任务');
      let { content, tool_calls } = choice.message;
      if (Array.isArray(content)) content = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (content != null && typeof content !== 'string') throw Error('模型 content 类型无效');
      if (c.mode === 'json' && !structured) {
        let json; try { json = JSON.parse((content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch { throw Error('JSON 工具模式要求模型只输出一个 JSON 对象；请检查模型模板'); }
        if (json.tool) tool_calls = [{ id: `json_${crypto.randomUUID()}`, type: 'function', function: { name: json.tool, arguments: JSON.stringify(json.arguments || {}) } }];
        else if (typeof json.final === 'string') content = json.final;
        else throw Error('JSON 模式必须返回 {tool,arguments} 或 {final}');
      }
      if (tool_calls && (!Array.isArray(tool_calls) || tool_calls.length > 8)) throw Error('每轮最多接受 8 个工具调用');
      const seen = new Set();
      const calls = (tool_calls || []).map(t => {
        if (typeof t?.id !== 'string' || seen.has(t.id) || typeof t?.function?.name !== 'string' || typeof t?.function?.arguments !== 'string') throw Error('模型工具调用格式错误或 ID 重复');
        seen.add(t.id); return { id: t.id, type: 'function', function: t.function };
      });
      return { content: content || '', calls, usage: data.usage };
    } finally { release(); }
  }
  async json(system, data, signal, { track = 'local' } = {}) {
    const result = await this.complete([{ role: 'system', content: `${system}\n只输出一个 JSON 对象，不调用工具，不输出Markdown。` }, { role: 'user', content: typeof data === 'string' ? data : JSON.stringify(data) }], [], signal, { track, structured: true });
    if (result.calls.length) throw Error('结构化子任务不得调用工具');
    let value; try { value = JSON.parse(result.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch { throw Error('结构化子任务未返回 JSON 对象'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('结构化子任务输出无效');
    return value;
  }
}
