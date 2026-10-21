/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The AI provider catalogue
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One manifest per provider, exactly like `integration-catalogue.ts` and
 * `rule-node-catalogue.ts`. The frontend renders its provider gallery AND its
 * credential form from this table, so adding a provider is a manifest plus an
 * adapter and no frontend change.
 *
 * Modelled on ThingsBoard's AI Models registry so the mental model transfers:
 * a tenant registers models once under Settings, and the `ai_request` rule
 * node references one by id rather than carrying credentials itself. That
 * separation is the whole point — a rule chain is exportable and shareable,
 * and an API key must never travel with it.
 */

export type AiProvider =
  | 'openai'
  | 'anthropic'
  | 'azure_openai'
  | 'google_gemini'
  | 'mistral'
  | 'ollama';

export type AiFieldType = 'text' | 'password' | 'number' | 'select';

export interface AiProviderField {
  key: string;
  label: string;
  type: AiFieldType;
  /**
   * Where the value belongs in the payload.
   *
   * `column` fields are real columns on AiModel and are sent at the top
   * level; `providerOptions` fields go in that jsonb bag. The form is
   * GENERATED from this table, so without the flag the frontend has to
   * hardcode the split — and the global ValidationPipe runs
   * `forbidNonWhitelisted`, so guessing wrong is a 400 rather than a
   * harmless extra key. Defaults to `column`.
   */
  scope?: 'column' | 'providerOptions';
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: unknown;
  secret?: boolean;
  /** Required when type is 'select'; ignored otherwise. */
  options?: Array<{ value: string; label: string }>;
}

export interface AiProviderManifest {
  provider: AiProvider;
  label: string;
  description: string;
  /** Shown in the picker; purely presentational. */
  icon: string;
  /** Example model identifiers, for the autocomplete. Never a hard list. */
  exampleModels: string[];
  /**
   * Whether the provider supports schemaless JSON mode.
   *
   * Anthropic and Bedrock do not: they need an explicit schema. A UI that
   * offers plain "JSON" for those providers produces runtime failures that
   * look like model misbehaviour, so the catalogue states it and the service
   * refuses the combination up front.
   */
  supportsSchemalessJson: boolean;
  fields: AiProviderField[];
}

const API_KEY: AiProviderField = {
  key: 'apiKey',
  label: 'API key',
  type: 'password',
  required: true,
  secret: true,
};

export const AI_PROVIDER_CATALOGUE: AiProviderManifest[] = [
  {
    provider: 'openai',
    label: 'OpenAI',
    description:
      'GPT models via api.openai.com, or any OpenAI-compatible endpoint ' +
      '(vLLM, LM Studio, OpenRouter) by overriding the base URL.',
    icon: 'sparkles',
    // ⚠️  UNVERIFIED AGAINST THE VENDOR. These were current when written and
    // have not been rechecked. A retired id here produces the same 404 the
    // Anthropic list produced — see the note on that provider's
    // `exampleModels`. Anyone touching this should check OpenAI's current
    // model list and deprecation page rather than trusting the array.
    exampleModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
    supportsSchemalessJson: true,
    fields: [
      API_KEY,
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: 'https://api.openai.com/v1',
        help: 'Override to point at an OpenAI-compatible server.',
      },
    ],
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models via api.anthropic.com.',
    icon: 'sparkles',
    // One per tier: most capable, balanced, fastest.
    //
    // These are suggestions shown in the UI, so a stale entry is not a
    // cosmetic problem — someone picks it and the request 404s with
    // `model: claude-opus-4-20250514`, which reads like a platform bug rather
    // than a retired model. The previous three were ALL retired:
    //
    //   claude-opus-4-20250514     retired 2026-06-15
    //   claude-sonnet-4-20250514   retired 2026-06-15
    //   claude-3-5-haiku-20241022  retired 2026-02-19
    //
    // Anthropic publishes retirement dates in advance at
    // https://platform.claude.com/docs/en/about-claude/model-deprecations —
    // worth a glance whenever this list is touched. Aliases without a date
    // suffix (`claude-opus-5-5`) track the family and age better than a
    // pinned snapshot.
    exampleModels: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ],
    // Anthropic has no schemaless JSON mode — a schema is required.
    supportsSchemalessJson: false,
    fields: [
      API_KEY,
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: 'https://api.anthropic.com',
      },
      {
        key: 'anthropicVersion',
        label: 'API version',
        type: 'text',
        scope: 'providerOptions',
        default: '2023-06-01',
        help: 'Sent as the anthropic-version header.',
      },
      {
        key: 'workspaceId',
        label: 'Workspace ID',
        type: 'text',
        scope: 'providerOptions',
        placeholder: 'wrkspc_…',
        help:
          'Optional. Only needed when the API key is not tied to a Workspace — ' +
          'the provider then refuses the request with "This API key is not ' +
          'scoped to a workspace". Leave empty for a key created inside a ' +
          'Workspace. Sent as the anthropic-workspace-id header.',
      },
    ],
  },
  {
    provider: 'azure_openai',
    label: 'Azure OpenAI',
    description:
      'OpenAI models hosted in your Azure subscription. The model id is the ' +
      'DEPLOYMENT name, not the base model name.',
    icon: 'cloud',
    exampleModels: ['my-gpt4o-deployment'],
    supportsSchemalessJson: true,
    fields: [
      API_KEY,
      {
        key: 'baseUrl',
        label: 'Endpoint',
        type: 'text',
        required: true,
        placeholder: 'https://<resource>.openai.azure.com',
      },
      {
        key: 'apiVersion',
        label: 'Service version',
        type: 'text',
        scope: 'providerOptions',
        default: '2024-10-21',
      },
    ],
  },
  {
    provider: 'google_gemini',
    label: 'Google Gemini',
    description: 'Gemini models via the Google AI Studio API key flow.',
    icon: 'sparkles',
    // ⚠️  UNVERIFIED AGAINST THE VENDOR — same caveat as the OpenAI list
    // above. `gemini-1.5-pro` in particular is a pinned older generation.
    exampleModels: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    supportsSchemalessJson: true,
    fields: [
      API_KEY,
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: 'https://generativelanguage.googleapis.com',
      },
    ],
  },
  {
    provider: 'mistral',
    label: 'Mistral AI',
    description: 'Mistral models via api.mistral.ai.',
    icon: 'sparkles',
    // These use Mistral's `-latest` aliases, which follow the family instead
    // of pinning a snapshot — the pattern the other lists should move toward,
    // since it is the one that does not silently age into a 404.
    exampleModels: ['mistral-large-latest', 'mistral-small-latest'],
    supportsSchemalessJson: true,
    fields: [
      API_KEY,
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: 'https://api.mistral.ai',
      },
    ],
  },
  {
    provider: 'ollama',
    label: 'Ollama (self-hosted)',
    description:
      'A model running on your own hardware. No data leaves your network, ' +
      'which is the usual reason to pick it for telemetry.',
    icon: 'server',
    exampleModels: ['llama3.2', 'mistral', 'qwen2.5'],
    supportsSchemalessJson: true,
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        required: true,
        default: 'http://localhost:11434',
      },
      { ...API_KEY, required: false, label: 'Bearer token (optional)' },
    ],
  },
];

export const AI_PROVIDERS: AiProvider[] = AI_PROVIDER_CATALOGUE.map(
  (m) => m.provider,
);

export const getAiProviderManifest = (
  provider: AiProvider,
): AiProviderManifest | undefined =>
  AI_PROVIDER_CATALOGUE.find((m) => m.provider === provider);

/** Response shapes the `ai_request` node can ask for. */
export type AiResponseFormatType = 'TEXT' | 'JSON' | 'JSON_SCHEMA';
