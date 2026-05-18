/**
 * Thin wrappers around external AI providers.
 * Failing calls log + return safe fallbacks; callers should still update node row.
 *
 * Helicone routing: if HELICONE_API_KEY is set, Groq + DeepSeek requests are
 * proxied through Helicone for cost / latency / usage observability.
 *   - Groq:     POST gateway.helicone.ai → Helicone-Target-URL: api.groq.com
 *   - DeepSeek: POST gateway.helicone.ai → Helicone-Target-URL: api.deepseek.com
 * Jina is hit directly (Helicone doesn't auto-instrument embeddings the same way).
 *
 * We add Helicone-Property headers for slice-and-dice in Helicone:
 *   - Helicone-Property-Feature: ner | summary | chat | reasoning
 *   - Helicone-User-Id: forwarded via opts.userId (when available)
 */

const HELICONE_GATEWAY = 'https://gateway.helicone.ai/v1';
const GROQ_DIRECT = 'https://api.groq.com/openai/v1';
const DEEPSEEK_DIRECT = 'https://api.deepseek.com';
const JINA_BASE = 'https://api.jina.ai/v1';

function heliconeHeaders(feature: string, userId?: string): Record<string, string> {
  const key = Deno.env.get('HELICONE_API_KEY');
  if (!key) return {};
  const h: Record<string, string> = {
    'Helicone-Auth': `Bearer ${key}`,
    'Helicone-Property-Feature': feature,
    'Helicone-Property-App': 'mesh',
  };
  if (userId) h['Helicone-User-Id'] = userId;
  return h;
}

function groqEndpoint(): { base: string; extraHeaders: Record<string, string> } {
  if (Deno.env.get('HELICONE_API_KEY')) {
    return {
      base: HELICONE_GATEWAY,
      extraHeaders: { 'Helicone-Target-URL': GROQ_DIRECT },
    };
  }
  return { base: GROQ_DIRECT, extraHeaders: {} };
}

function deepseekEndpoint(): { base: string; extraHeaders: Record<string, string> } {
  if (Deno.env.get('HELICONE_API_KEY')) {
    return {
      base: HELICONE_GATEWAY,
      extraHeaders: { 'Helicone-Target-URL': DEEPSEEK_DIRECT },
    };
  }
  return { base: DEEPSEEK_DIRECT, extraHeaders: {} };
}

export interface Entity {
  type: 'PERSON' | 'ORG' | 'LOCATION' | 'DATE' | 'PROJECT' | 'PRODUCT' | 'TOPIC';
  value: string;
  normalized: string;
}

export async function jinaEmbed(text: string): Promise<number[] | null> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) {
    console.warn('JINA_API_KEY missing — skipping embedding');
    return null;
  }
  const truncated = text.slice(0, 8000);
  try {
    const res = await fetch(`${JINA_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jina-embeddings-v3',
        task: 'retrieval.passage',
        dimensions: 1024,
        input: [truncated],
      }),
    });
    if (!res.ok) {
      console.error('Jina embed failed', res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch (e) {
    console.error('Jina embed error', e);
    return null;
  }
}

export async function groqChat(opts: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  maxTokens?: number;
  feature?: string;
  userId?: string;
}): Promise<string | null> {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey) {
    console.warn('GROQ_API_KEY missing — skipping LLM call');
    return null;
  }
  try {
    const { base, extraHeaders } = groqEndpoint();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...heliconeHeaders(opts.feature ?? 'groq-chat', opts.userId),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        temperature: 0.1,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      console.error('Groq chat failed', res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? null;
  } catch (e) {
    console.error('Groq chat error', e);
    return null;
  }
}

export async function extractEntities(content: string): Promise<Entity[]> {
  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt:
      'You extract named entities from text and return strict JSON only. ' +
      'No prose, no markdown, no explanation.',
    userPrompt: `Extract named entities. Types allowed: PERSON, ORG, LOCATION, DATE, PROJECT, PRODUCT, TOPIC.
For each: {"type":"...","value":"original spelling","normalized":"lowercase no accents singular"}.
Return JSON: {"entities":[...]}. Max 15 entities.

Text:
"""
${content.slice(0, 4000)}
"""`,
    jsonMode: true,
    maxTokens: 700,
  });

  if (!result) return [];
  try {
    const parsed = JSON.parse(result) as { entities?: Entity[] };
    if (!Array.isArray(parsed.entities)) return [];
    return parsed.entities
      .filter(
        (e): e is Entity =>
          !!e && typeof e === 'object' && typeof e.value === 'string' && typeof e.type === 'string',
      )
      .slice(0, 15);
  } catch (e) {
    console.warn('Entity parse failed', e);
    return [];
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Streaming chat completion via Groq (OpenAI-compatible SSE).
 * Returns a ReadableStream of UTF-8 text chunks already extracted from SSE deltas.
 */
export async function groqChatStream(opts: {
  model?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  feature?: string;
  userId?: string;
}): Promise<ReadableStream<Uint8Array>> {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "I can't reach the LLM yet — please set GROQ_API_KEY on the server.",
          ),
        );
        controller.close();
      },
    });
  }

  const { base, extraHeaders } = groqEndpoint();
  const upstream = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
      ...heliconeHeaders(opts.feature ?? 'chat-stream', opts.userId),
    },
    body: JSON.stringify({
      model: opts.model ?? 'llama-3.3-70b-versatile',
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`Upstream LLM error (${upstream.status}): ${detail.slice(0, 200)}`),
        );
        controller.close();
      },
    });
  }

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              controller.close();
              return;
            }
            try {
              const j = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const chunk = j.choices?.[0]?.delta?.content;
              if (chunk) controller.enqueue(encoder.encode(chunk));
            } catch {
              /* ignore keepalive */
            }
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}

export async function deepseekReason(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  feature?: string;
  userId?: string;
}): Promise<string | null> {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    console.warn('DEEPSEEK_API_KEY missing — skipping reasoning');
    return null;
  }
  try {
    const { base, extraHeaders } = deepseekEndpoint();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...heliconeHeaders(opts.feature ?? 'deepseek-reasoning', opts.userId),
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        max_tokens: opts.maxTokens ?? 2000,
      }),
    });
    if (!res.ok) {
      console.error('DeepSeek failed', res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? null;
  } catch (e) {
    console.error('DeepSeek error', e);
    return null;
  }
}

export async function summarize(content: string): Promise<string | null> {
  return await groqChat({
    model: 'llama-3.3-70b-versatile',
    systemPrompt:
      'You write concise factual summaries. Max 2 sentences. Match the input language.',
    userPrompt: `Summarize in <=2 sentences, no preamble:\n\n${content.slice(0, 6000)}`,
    maxTokens: 200,
  });
}
