// src/modules/protocols/lwm2m/entities/lwm2m-registration.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../../tenants/entities/tenant.entity';
import type { Device } from '../../../devices/entities/device.entity';
import type { Customer } from '../../../customers/entities/customers.entity';

/** One object/instance the client advertised in its registration payload. */
export interface Lwm2mObjectLinkRow {
  path: string;
  attributes: Record<string, string>;
}

/**
 * A live LwM2M client registration.
 *
 * ─── Why this table exists ────────────────────────────────────────────────
 * `Lwm2mService` kept its whole registry in two in-process `Map`s. Three
 * consequences, all of them silent:
 *
 *   1. **Every registration was lost on restart.** A client with a 24-hour
 *      lifetime would not re-register for up to a day, and in the meantime its
 *      Update was answered 4.04 and its Send 4.03 — so a deploy took the fleet
 *      offline with no log line saying why.
 *   2. **Nothing was shared across replicas.** A client that registered
 *      against replica A and then sent to replica B was rejected as unknown.
 *   3. **`GET /lwm2m/registrations` reported one node's memory** as though it
 *      were the platform's state.
 *
 * The table is now authoritative; the service keeps a cache in front of it for
 * the hot path and rehydrates from here on boot.
 *
 * ─── `endpoint` vs `endpointHash` ─────────────────────────────────────────
 * The LwM2M endpoint name is also the **credential** this server authenticates
 * with (there is no DTLS/PSK in this stack — see `lwm2m.scope.ts`), so storing
 * it verbatim would put an access token in a column that
 * `GET /lwm2m/registrations` returns.
 *
 * So: `endpointHash` is SHA-256 of the name as the client presented it and is
 * what lookups go through (`?ep=` on /dp, and re-registration replacing a
 * previous registration). `endpoint` holds the **device key** of the device
 * that authenticated — a public identifier — which is what the UI shows. When
 * enforcement is off and the endpoint name really is just a device key, the
 * two coincide.
 */
@Entity('lwm2m_registrations')
@Index(['tenantId', 'expiresAt'])
@Index(['tenantId', 'deviceId'])
@Index(['expiresAt'])
export class Lwm2mRegistration extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // SCOPING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  /**
   * The device that authenticated.
   *
   * Persisted so later Update / Send / De-register calls are bound to the
   * device whose credential was accepted at registration, instead of
   * re-resolving an attacker-chosen endpoint name on every request.
   */
  @Column({ type: 'uuid' })
  deviceId: string;

  @ManyToOne('Device', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Relation<Device>;

  // ══════════════════════════════════════════════════════════════════════════
  // IDENTITY
  // ══════════════════════════════════════════════════════════════════════════

  /** The id the client quotes in Update and De-register. Unique. */
  @Column({ type: 'varchar', length: 32, unique: true })
  registrationId: string;

  /** Display name — the authenticated device's key, never the credential. */
  @Column({ type: 'varchar', length: 255 })
  endpoint: string;

  /** SHA-256 of the endpoint name as presented. The lookup key. */
  @Column({ type: 'char', length: 64 })
  endpointHash: string;

  // ══════════════════════════════════════════════════════════════════════════
  // REGISTRATION STATE
  // ══════════════════════════════════════════════════════════════════════════

  /** Seconds. */
  @Column({ type: 'int' })
  lifetime: number;

  /** "U" | "UQ" | "T" | … — recorded, not acted on (Queue Mode is out of scope). */
  @Column({ type: 'varchar', length: 8, default: 'U' })
  bindingMode: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  lwm2mVersion?: string | null;

  /** The CoRE Link Format object list the client advertised. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  objects: Lwm2mObjectLinkRow[];

  /**
   * Source address of the registration.
   *
   * Used to identify a /dp Send that carries no `?ep=`. Without DTLS this is
   * a convenience, NOT an authentication mechanism — a UDP source address is
   * trivially spoofed.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  address?: string | null;

  @Column({ type: 'int', nullable: true })
  port?: number | null;

  @Column({ type: 'timestamp' })
  registeredAt: Date;

  @Column({ type: 'timestamp' })
  lastUpdateAt: Date;

  /** lastUpdateAt + lifetime + LWM2M_LIFETIME_GRACE_SECONDS. */
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * False when this registration was accepted with no credential because
   * `DEVICE_AUTH_ENFORCED=false`. Recorded so an operator can see which
   * registrations predate enforcement rather than having to infer it.
   */
  @Column({ type: 'boolean', default: true })
  authenticated: boolean;

  /** ACCESS_TOKEN, MQTT_BASIC, … or null for an unauthenticated registration. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  credentialsType?: string | null;

  isExpired(now: Date = new Date()): boolean {
    return this.expiresAt <= now;
  }
}
