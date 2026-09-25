// Celsus OS, LLM client. OpenRouter chat completions. The LLM writes; it never decides. Jev decides.
import { requireConfig } from './config.ts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }
export interface ChatResult { model: string; content: string; latencyMs: number; usage?: { prompt_tokens: number; completion_tokens: number; cost?: number }; reasoningChars: number }

export async function chat(messages: ChatMessage[], opts: { model?: string; maxTokens?: number; json?: boolean; timeoutMs?: number } = {}): Promise<ChatResult> {
  const cfg = requireConfig();
  const model = opts.model || cfg.llm;
  const body: any = { model, messages, max_tokens: opts.maxTokens || cfg.llmMaxTokens };
  if (opts.json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 90000);
  const t0 = Date.now();
  try {
    const base = (cfg.llmBaseUrl || '').replace(/\/$/, '');
    const url = base ? `${base}/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Title': 'Celsus OS' };
    if (!base) headers.Authorization = `Bearer ${cfg.openrouterKey}`; else headers.Authorization = 'Bearer local';
    if (base) delete body.response_format; // most local servers reject it; extractJson copes
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const json: any = await res.json();
    if (!res.ok || json.error) throw new Error(`LLM ${res.status}: ${JSON.stringify(json.error || json).slice(0, 300)}`);
    const msg = json.choices?.[0]?.message || {};
    return { model: json.model, content: msg.content || '', latencyMs: Date.now() - t0, usage: json.usage, reasoningChars: (msg.reasoning || '').length };
  } finally { clearTimeout(timer); }
}

/** Pull the first JSON object out of a reply, tolerating code fences and reasoning models that talk first. */
export function extractJson<T = any>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}
