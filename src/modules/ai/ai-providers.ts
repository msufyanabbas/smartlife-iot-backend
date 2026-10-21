import { Logger } from '@nestjs/common';
import type { AiProvider, AiResponseFormatType } from './ai-provider.catalogue';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider adapters
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One function per provider, all reduced to the same shape: a system prompt, a
 * user prompt, a response format, and back a string. Everything above this
 * file — the rule node, the insight endpoint, the connectivity check — talks
 * only to `callProvider()` and never knows which vendor answered.
 *
 * `fetch` rather than axios: these are one-shot calls with a hard deadline and
 * no retry, and `AbortSignal.timeout` expresses that in one line. Retries are
 * deliberately absent — a rule chain that silently retries an LLM call three
 * times is three times the bill for a message the operator thought failed
 * once. The node routes to `failure` and the chain decides.
 */

const logger = new Logger('AiProviders');

export interface AiCallRequest {
  provider: AiProvider;
  modelId: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  providerOptions?: Record<string, unknown> | null;
  systemPrompt?: string | null;
  userPrompt: string;
  responseFormat: AiResponseFormatType;
  /** Required when responseFormat is JSON_SCHEMA. */
  schema?: Record<string, unknown> | null;
  temperature?: number | null;
  topP?: number | null;
  maxOutputTokens?: number | null;
  timeoutMs: number;
}

export interface AiCallResult {
  /** The raw text the model returned. */
  text: string;
  /** Token counts when the provider reports them. */
  usage?: { inputTokens?: number; outputTokens?: number };
  model?: string;
}

const DEFAULT_MAX_TOKENS = 1024;

/** Drop null/undefined so a provider sees "absent", not "null". */
const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined),
  ) as T;

/**
 * Turn a provider's error body into something an operator can act on.
 *
 * The raw pass-through is accurate and useless. Both of these, verbatim, are
 * what someone configuring a model actually saw:
 *
 *   Provider returned 400: {"type":"error","error":{"type":"invalid_request_error",
 *     "message":"This API key is not scoped to a workspace, so this request must
 *     include the anthropic-workspace-id header..."}}
 *
 *   Provider returned 404: {"type":"error","error":{"type":"not_found_error",
 *     "message":"model: claude-opus-4-20250514"}}
 *
 * Neither reads like a configuration problem, and the second reads like a bug
 * in this platform. The returned string is a PREFIX — the original body still
 * follows, because a guess that turns out wrong must not hide the evidence.
 *
 * Deliberately pattern-matched on the message text rather than on a status
 * code alone: a 404 from a wrong `baseUrl` is a different problem from a 404
 * naming a model, and telling someone to check model retirement when their
 * URL is wrong wastes more time than saying nothing.
 */
function explainProviderError(status: number, raw: string): string {
  const body = raw.toLowerCase();
  const hint = (text: string) => `${text}\n\n`;

  // A model that existed when the integration was configured and does not
  // now. Anthropic publishes retirement dates ahead of time.
  if (status === 404 && /not_found_error|model:/.test(body)) {
    const named = raw.match(/model:\s*([\w.:-]+)/)?.[1];
    return hint(
      `The provider does not recognise ${
        named ? `the model "${named}"` : 'the configured model'
      }. The usual cause is a RETIRED model: a model id that worked when this ` +
        `was configured stops being served on a published date. Check the ` +
        `model id on the AI model's settings against the provider's current ` +
        `list — for Anthropic, ` +
        `https://platform.claude.com/docs/en/about-claude/model-deprecations ` +
        `lists active models and retirement dates. A wrong Base URL produces ` +
        `this too.`,
    );
  }

  // Anthropic: an API key that belongs to no Workspace.
  if (/anthropic-workspace-id/.test(body)) {
    return hint(
      'This Anthropic API key is not tied to a Workspace, so the API cannot ' +
        'tell which Workspace to run the request under. Either create a new ' +
        'key from inside a Workspace in the Console (keys belong to the ' +
        'Workspace they are created in), or set a workspaceId in this model’s ' +
        'settings so the anthropic-workspace-id header is sent.',
    );
  }

  if (status === 401 || status === 403) {
    return hint(
      'The provider rejected the credential. The key is wrong, revoked, or ' +
        'lacks access to this model. Re-enter it on the AI model — the stored ' +
        'key is encrypted and never shown back, so a partial paste looks ' +
        'identical to a correct one here.',
    );
  }

  if (status === 429) {
    return hint(
      'Rate-limited or out of quota at the provider. This is the provider’s ' +
        'limit, not a platform limit, so retrying immediately will fail the ' +
        'same way.',
    );
  }

  // 529 is Anthropic's "overloaded"; 5xx generally is worth retrying.
  if (status >= 500) {
    return hint(
      'The provider failed, not the request. Worth retrying; if it persists, ' +
        'check the provider’s status page before changing any configuration.',
    );
  }

  return '';
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: any) {
    // A timeout and a DNS failure are different problems for the operator.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Could not reach the provider: ${error?.message ?? error}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    // Provider error bodies carry the actionable part (bad key, unknown
    // model, rate limit). Pass it through, truncated — some are enormous —
    // and prepend what to DO about the shapes we recognise.
    throw new Error(
      `${explainProviderError(response.status, raw)}Provider returned ${response.status}: ${
        raw.slice(0, 400) || response.statusText
      }`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Provider returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// ── OpenAI and every OpenAI-compatible server ────────────────────────────────

async function callOpenAiCompatible(
  req: AiCallRequest,
  url: string,
  headers: Record<string, string>,
): Promise<AiCallResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  messages.push({ role: 'user', content: req.userPrompt });

  let response_format: unknown;
  if (req.responseFormat === 'JSON') {
    response_format = { type: 'json_object' };
  } else if (req.responseFormat === 'JSON_SCHEMA' && req.schema) {
    response_format = {
      type: 'json_schema',
      json_schema: {
        name: (req.schema as any).title ?? 'response',
        schema: req.schema,
        strict: false,
      },
    };
  }

  const json = await postJson(
    url,
    headers,
    compact({
      model: req.modelId,
      messages,
      temperature: req.temperature,
      top_p: req.topP,
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      response_format,
    }),
    req.timeoutMs,
  );

  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('Provider response had no message content');
  }
  return {
    text,
    model: json?.model,
    usage: {
      inputTokens: json?.usage?.prompt_tokens,
      outputTokens: json?.usage?.completion_tokens,
    },
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(req: AiCallRequest): Promise<AiCallResult> {
  const base = (req.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const version =
    (req.providerOptions?.anthropicVersion as string) || '2023-06-01';

  // Optional. An Anthropic API key belongs to the Workspace it was created
  // in; a key that belongs to none is refused with
  // `This API key is not scoped to a workspace`, and the request has to name
  // one. Left unset for the ordinary case of a workspace-scoped key, where
  // sending the header is unnecessary — and per-model rather than global, so
  // tenants can bill to different Workspaces.
  const workspaceId = (req.providerOptions?.workspaceId as string)?.trim();

  // Anthropic has no response_format parameter. Structured output is steered
  // by the schema in the system prompt — which is exactly why the catalogue
  // marks the provider as not supporting schemaless JSON: without a schema
  // there is nothing to steer with.
  let system = req.systemPrompt ?? '';
  if (req.responseFormat === 'JSON_SCHEMA' && req.schema) {
    system +=
      `\n\nRespond with JSON only — no prose, no code fences — matching ` +
      `this JSON Schema:\n${JSON.stringify(req.schema)}`;
  }

  const json = await postJson(
    `${base}/v1/messages`,
    {
      'x-api-key': req.apiKey ?? '',
      'anthropic-version': version,
      ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
    },
    compact({
      model: req.modelId,
      system: system.trim() || undefined,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature,
      top_p: req.topP,
    }),
    req.timeoutMs,
  );

  const text = (json?.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('');
  if (!text) throw new Error('Provider response had no text content');

  return {
    text,
    model: json?.model,
    usage: {
      inputTokens: json?.usage?.input_tokens,
      outputTokens: json?.usage?.output_tokens,
    },
  };
}

// ── Google Gemini ────────────────────────────────────────────────────────────

async function callGemini(req: AiCallRequest): Promise<AiCallResult> {
  const base = (
    req.baseUrl || 'https://generativelanguage.googleapis.com'
  ).replace(/\/+$/, '');
  const url =
    `${base}/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent` +
    `?key=${encodeURIComponent(req.apiKey ?? '')}`;

  const generationConfig: Record<string, unknown> = compact({
    temperature: req.temperature,
    topP: req.topP,
    maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  });
  if (req.responseFormat !== 'TEXT') {
    generationConfig.responseMimeType = 'application/json';
    if (req.responseFormat === 'JSON_SCHEMA' && req.schema) {
      generationConfig.responseSchema = req.schema;
    }
  }

  const json = await postJson(
    url,
    {},
    compact({
      contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
      systemInstruction: req.systemPrompt
        ? { parts: [{ text: req.systemPrompt }] }
        : undefined,
      generationConfig,
    }),
    req.timeoutMs,
  );

  const text = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('');
  if (!text) throw new Error('Provider response had no text content');

  return {
    text,
    model: req.modelId,
    usage: {
      inputTokens: json?.usageMetadata?.promptTokenCount,
      outputTokens: json?.usageMetadata?.candidatesTokenCount,
    },
  };
}

// ── Ollama ───────────────────────────────────────────────────────────────────

async function callOllama(req: AiCallRequest): Promise<AiCallResult> {
  const base = (req.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  messages.push({ role: 'user', content: req.userPrompt });

  const headers: Record<string, string> = {};
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;

  const json = await postJson(
    `${base}/api/chat`,
    headers,
    compact({
      model: req.modelId,
      messages,
      stream: false,
      // Ollama takes a JSON Schema directly in `format`, or the string
      // 'json' for schemaless.
      format:
        req.responseFormat === 'JSON_SCHEMA' && req.schema
          ? req.schema
          : req.responseFormat === 'JSON'
            ? 'json'
            : undefined,
      options: compact({
        temperature: req.temperature,
        top_p: req.topP,
        num_predict: req.maxOutputTokens,
      }),
    }),
    req.timeoutMs,
  );

  const text = json?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('Provider response had no message content');
  }
  return {
    text,
    model: json?.model,
    usage: {
      inputTokens: json?.prompt_eval_count,
      outputTokens: json?.eval_count,
    },
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function callProvider(req: AiCallRequest): Promise<AiCallResult> {
  const started = Date.now();
  try {
    switch (req.provider) {
      case 'openai': {
        const base = (req.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
        return await callOpenAiCompatible(req, `${base}/chat/completions`, {
          authorization: `Bearer ${req.apiKey ?? ''}`,
        });
      }
      case 'mistral': {
        const base = (req.baseUrl || 'https://api.mistral.ai').replace(/\/+$/, '');
        return await callOpenAiCompatible(req, `${base}/v1/chat/completions`, {
          authorization: `Bearer ${req.apiKey ?? ''}`,
        });
      }
      case 'azure_openai': {
        if (!req.baseUrl) throw new Error('Azure OpenAI requires an endpoint');
        const apiVersion =
          (req.providerOptions?.apiVersion as string) || '2024-10-21';
        const base = req.baseUrl.replace(/\/+$/, '');
        // On Azure the "model id" is the deployment name, and it lives in the
        // path rather than the body.
        return await callOpenAiCompatible(
          req,
          `${base}/openai/deployments/${encodeURIComponent(req.modelId)}` +
            `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
          { 'api-key': req.apiKey ?? '' },
        );
      }
      case 'anthropic':
        return await callAnthropic(req);
      case 'google_gemini':
        return await callGemini(req);
      case 'ollama':
        return await callOllama(req);
      default:
        throw new Error(`Unsupported provider '${req.provider}'`);
    }
  } finally {
    // Duration and model only. The prompt may carry customer telemetry and
    // must not reach the log.
    logger.log(
      `[ai] ${req.provider}/${req.modelId} ${Date.now() - started}ms`,
    );
  }
}
