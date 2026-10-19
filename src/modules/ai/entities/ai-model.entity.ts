// src/modules/ai/entities/ai-model.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { AiProvider } from '../ai-provider.catalogue';

/**
 * A registered LLM a tenant can call.
 *
 * Credentials live HERE and not in the rule node that uses them. A rule chain
 * is exportable, importable and shareable between tenants (§4f), so a provider
 * key embedded in a node's `configuration` jsonb would travel with every
 * export. The node stores only `modelId` — a uuid pointing at this row — and
 * resolution is tenant-scoped at call time.
 */
@Entity('ai_models')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'provider'])
@Unique('UQ_ai_models_tenant_name', ['tenantId', 'name'])
export class AiModel extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Operator-facing name, unique per tenant. */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 64 })
  provider: AiProvider;

  /**
   * The provider's own model identifier — `gpt-4o`, `claude-sonnet-4-…`, or
   * on Azure the DEPLOYMENT name. Free text on purpose: providers ship new
   * models constantly and an enum here would need a migration every time.
   */
  @Column({ type: 'varchar', length: 200 })
  modelId: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // CREDENTIALS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * AES-256-GCM ciphertext of the API key, never the key itself.
   *
   * `select: false` so it cannot leave through a careless `find()` — the
   * service asks for it explicitly, only on the call path. Compare
   * `integrations.configuration`, which holds cloud credentials in PLAINTEXT
   * jsonb with only `select: false` in front of them; that is the weaker
   * pattern and this one should be the template when it is fixed.
   */
  @Column({ type: 'text', nullable: true, select: false })
  apiKeyEncrypted?: string | null;

  /** Base URL / Azure endpoint / Ollama host. Not a secret. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  baseUrl?: string | null;

  /** Provider-specific non-secret settings (apiVersion, anthropicVersion, …). */
  @Column({ type: 'jsonb', nullable: true })
  providerOptions?: Record<string, unknown> | null;

  // ══════════════════════════════════════════════════════════════════════════
  // GENERATION PARAMETERS
  //
  // Nullable throughout: a null means "do not send it", so the provider's own
  // default applies. Sending a zero would be a different, and wrong, request.
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'double precision', nullable: true })
  temperature?: number | null;

  @Column({ type: 'double precision', nullable: true })
  topP?: number | null;

  @Column({ type: 'int', nullable: true })
  maxOutputTokens?: number | null;

  // ══════════════════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Result of the last connectivity check, for the settings screen. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lastCheckStatus?: 'ok' | 'error' | null;

  @Column({ type: 'text', nullable: true })
  lastCheckMessage?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastCheckAt?: Date | null;

  /**
   * Count only — never the prompts or completions.
   *
   * Telemetry prompts can carry customer data, and a usage log that stored
   * them would quietly become a second copy of the tenant's data in a table
   * nobody is watching.
   */
  @Column({ type: 'bigint', default: 0 })
  requestCount: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date | null;
}
