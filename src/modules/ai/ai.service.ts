import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiModel } from './entities/ai-model.entity';
import {
  AI_PROVIDER_CATALOGUE,
  getAiProviderManifest,
  type AiProvider,
  type AiResponseFormatType,
} from './ai-provider.catalogue';
import { callProvider, type AiCallResult } from './ai-providers';
import { encryptSecret, decryptSecret, isEncrypted } from '@common/utils/secret-box';

export interface AiCompleteOptions {
  systemPrompt?: string | null;
  userPrompt: string;
  responseFormat?: AiResponseFormatType;
  schema?: Record<string, unknown> | null;
  timeoutSeconds?: number;
}

/** What the rule node and the insight endpoint both get back. */
export interface AiCompletion {
  /** The parsed object when the model returned one, else `{ response: text }`. */
  data: Record<string, unknown>;
  raw: string;
  model?: string;
  usage?: AiCallResult['usage'];
}

const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 600;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiModel)
    private readonly repo: Repository<AiModel>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CATALOGUE
  // ══════════════════════════════════════════════════════════════════════════

  getCatalogue() {
    return AI_PROVIDER_CATALOGUE;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD — every query pinned to the tenant
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string): Promise<AiModel[]> {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }

  async findOne(id: string, tenantId: string): Promise<AiModel> {
    const model = await this.repo.findOne({ where: { id, tenantId } });
    // 404 rather than 403: a 403 would confirm the id exists in some other
    // tenant, which turns this route into an enumeration oracle (§4g).
    if (!model) throw new NotFoundException('AI model not found');
    return model;
  }

  async create(tenantId: string, dto: Partial<AiModel> & { apiKey?: string }) {
    this.assertProvider(dto.provider as AiProvider);
    this.assertRequiredFields(dto.provider as AiProvider, dto);

    const model = this.repo.create({
      ...this.scrub(dto),
      tenantId,
      apiKeyEncrypted: dto.apiKey ? encryptSecret(dto.apiKey) : null,
      requestCount: '0',
    });
    return this.repo.save(model);
  }

  async update(
    id: string,
    tenantId: string,
    dto: Partial<AiModel> & { apiKey?: string },
  ) {
    const existing = await this.findOne(id, tenantId);
    if (dto.provider) this.assertProvider(dto.provider as AiProvider);

    Object.assign(existing, this.scrub(dto));

    // Re-validate against the MERGED row, not the patch. Changing provider
    // from openai to azure_openai used to save happily without the endpoint
    // Azure requires, and then fail at call time — far from the edit that
    // caused it.
    //
    // `apiKeyEncrypted` is `select: false`, so `existing` never carries it and
    // "is a key already stored?" has to be asked separately — reading it off
    // `existing` silently answered "no" and made every credential-less PATCH
    // fail with "API key required".
    const hasStoredKey =
      (await this.repo
        .createQueryBuilder('m')
        .select('m.id')
        .addSelect('m.apiKeyEncrypted')
        .where('m.id = :id', { id })
        .getOne())?.apiKeyEncrypted != null;

    this.assertRequiredFields(existing.provider, {
      ...existing,
      apiKey: dto.apiKey ?? (hasStoredKey ? '__stored__' : undefined),
    });

    // An absent apiKey means "leave it alone" — the screen never receives the
    // stored key, so it cannot send it back, and treating absent as "clear"
    // would wipe the credential on every unrelated edit.
    if (typeof dto.apiKey === 'string' && dto.apiKey.length > 0) {
      existing.apiKeyEncrypted = encryptSecret(dto.apiKey);
    }
    return this.repo.save(existing);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const model = await this.findOne(id, tenantId);
    await this.repo.softRemove(model);
  }

  /** Strip fields the caller must never set directly. */
  private scrub(dto: Record<string, any>) {
    const {
      apiKey: _apiKey,
      apiKeyEncrypted: _enc,
      tenantId: _t,
      id: _id,
      requestCount: _rc,
      lastUsedAt: _lu,
      lastCheckStatus: _lcs,
      lastCheckMessage: _lcm,
      lastCheckAt: _lca,
      ...rest
    } = dto;
    return rest;
  }

  private assertProvider(provider?: AiProvider) {
    if (!provider || !getAiProviderManifest(provider)) {
      throw new BadRequestException(
        `Unknown provider '${provider}'. Expected one of: ` +
          AI_PROVIDER_CATALOGUE.map((m) => m.provider).join(', '),
      );
    }
  }

  private assertRequiredFields(provider: AiProvider, dto: Record<string, any>) {
    const manifest = getAiProviderManifest(provider)!;
    const missing = manifest.fields
      .filter((f) => f.required)
      .filter((f) => {
        const value = f.key === 'apiKey' ? dto.apiKey : dto[f.key] ?? dto.providerOptions?.[f.key];
        return value === undefined || value === null || value === '';
      })
      .map((f) => f.label);
    if (missing.length) {
      // Every missing field at once — a form that reveals one problem per
      // submit is a form people give up on.
      throw new BadRequestException(
        `${manifest.label} requires: ${missing.join(', ')}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CALLING A MODEL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a registered model and call it.
   *
   * The only path to a provider. Nothing else loads `apiKeyEncrypted`, so
   * there is exactly one place where a credential is decrypted.
   */
  async complete(
    modelId: string,
    tenantId: string,
    options: AiCompleteOptions,
  ): Promise<AiCompletion> {
    const model = await this.repo
      .createQueryBuilder('m')
      .addSelect('m.apiKeyEncrypted')
      .where('m.id = :modelId', { modelId })
      .andWhere('m.tenantId = :tenantId', { tenantId })
      .getOne();

    if (!model) throw new NotFoundException('AI model not found');
    if (!model.enabled) {
      throw new BadRequestException(`AI model '${model.name}' is disabled`);
    }

    const result = await this.invoke(model, options);

    // Fire-and-forget: a counter must never fail the call it counts.
    this.repo
      .update(model.id, {
        requestCount: String(Number(model.requestCount ?? 0) + 1),
        lastUsedAt: new Date(),
      })
      .catch(() => undefined);

    return result;
  }

  /** The call itself, against an already-loaded row. */
  private async invoke(
    model: AiModel,
    options: AiCompleteOptions,
  ): Promise<AiCompletion> {
    const manifest = getAiProviderManifest(model.provider)!;
    const responseFormat = options.responseFormat ?? 'TEXT';

    if (responseFormat === 'JSON' && !manifest.supportsSchemalessJson) {
      throw new BadRequestException(
        `${manifest.label} has no schemaless JSON mode. Use JSON_SCHEMA and ` +
          `supply a schema.`,
      );
    }
    if (responseFormat === 'JSON_SCHEMA' && !options.schema) {
      throw new BadRequestException(
        'responseFormat JSON_SCHEMA requires a schema',
      );
    }

    const seconds = Math.min(
      Math.max(options.timeoutSeconds ?? 60, MIN_TIMEOUT),
      MAX_TIMEOUT,
    );

    const result = await callProvider({
      provider: model.provider,
      modelId: model.modelId,
      apiKey: decryptSecret(model.apiKeyEncrypted),
      baseUrl: model.baseUrl,
      providerOptions: model.providerOptions,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      responseFormat,
      schema: options.schema,
      temperature: model.temperature,
      topP: model.topP,
      maxOutputTokens: model.maxOutputTokens,
      timeoutMs: seconds * 1000,
    });

    return {
      data: normaliseResponse(result.text),
      raw: result.text,
      model: result.model,
      usage: result.usage,
    };
  }

  /**
   * Issue a real request so a saved model is known to work.
   *
   * This costs a few tokens at the provider — cheaper than discovering a
   * typo'd key when a rule chain fires at 3am.
   */
  async checkConnectivity(id: string, tenantId: string) {
    const model = await this.repo
      .createQueryBuilder('m')
      .addSelect('m.apiKeyEncrypted')
      .where('m.id = :id', { id })
      .andWhere('m.tenantId = :tenantId', { tenantId })
      .getOne();
    if (!model) throw new NotFoundException('AI model not found');

    const started = Date.now();
    try {
      const out = await this.invoke(model, {
        userPrompt: 'Reply with the single word: ok',
        responseFormat: 'TEXT',
        timeoutSeconds: 30,
      });
      await this.repo.update(model.id, {
        lastCheckStatus: 'ok',
        lastCheckMessage: null,
        lastCheckAt: new Date(),
      });
      return {
        success: true,
        latencyMs: Date.now() - started,
        reply: out.raw.slice(0, 200),
        credentialEncrypted: isEncrypted(model.apiKeyEncrypted),
      };
    } catch (error: any) {
      const message = error?.message ?? 'Unknown error';
      await this.repo.update(model.id, {
        lastCheckStatus: 'error',
        lastCheckMessage: message.slice(0, 500),
        lastCheckAt: new Date(),
      });
      return {
        success: false,
        latencyMs: Date.now() - started,
        error: message,
        credentialEncrypted: isEncrypted(model.apiKeyEncrypted),
      };
    }
  }

  /** The tenant's default model, for callers that do not name one. */
  async resolveDefaultModel(tenantId: string): Promise<AiModel | null> {
    return this.repo.findOne({
      where: { tenantId, enabled: true },
      order: { createdAt: 'ASC' },
    });
  }
}

/**
 * ThingsBoard's normalisation rule, which is a good one: a JSON **object**
 * passes through as the message data; anything else — plain prose, or a valid
 * but non-object JSON value such as an array — is wrapped as
 * `{ response: ... }`. Without the wrap, a downstream node reading
 * `msg.data.someKey` would break differently depending on the model's mood.
 */
export function normaliseResponse(text: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim();
  // Models fence JSON in markdown even when told not to.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (unfenced.startsWith('{')) {
    try {
      const parsed = JSON.parse(unfenced);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { response: parsed };
    } catch {
      // Not valid JSON after all — fall through and treat it as text.
    }
  }
  return { response: text };
}
