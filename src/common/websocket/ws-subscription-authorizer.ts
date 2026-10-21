/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WsSubscriptionAuthorizer — who is allowed to join which socket room
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three gateways let a client name the rooms it wants to join:
 *
 *   /ws         device:subscribe, dashboard:subscribe, widget:subscribe
 *   /alarms     subscribe:device, subscribe:customer
 *   telemetry   subscribe
 *
 * Every one of them called `client.join('device:' + id)` with the id taken
 * straight off the wire. `WsJwtGuard` runs first, so the caller is a real
 * user — but being a real user of tenant A says nothing about device D of
 * tenant B. Any authenticated account could stream any tenant's telemetry and
 * alarms by naming the uuid, and the server would have logged it as a normal
 * subscription.
 *
 * The guard proves identity. Nothing proved authorization. This does.
 *
 * Why it is a shared provider rather than a method on each gateway: the same
 * mistake was made independently in three files, which is what a rule with no
 * single home looks like. It lives in a module that depends on no feature
 * module (the Device repository only), so all three can import it without the
 * cycles that pushed the gateways into holding bare repositories in the first
 * place.
 *
 * Scoping rules, in order:
 *
 *   • SUPER_ADMIN is cross-tenant by definition → allowed.
 *   • Anyone else without a tenantId on their token → refused. A missing
 *     claim is not a wildcard; this is the direction that fails closed.
 *   • Otherwise the device must belong to the caller's tenant.
 *   • If the token carries a customerId (CUSTOMER / CUSTOMER_USER), the
 *     device must also be assigned to that customer. A customer user of
 *     tenant A must not see tenant A's other customers' devices.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { UserRole } from '@common/enums/user.enum';
import { Device } from '@modules/devices/entities/device.entity';

/**
 * What the authorizer needs off a socket. Declared structurally so all three
 * gateways satisfy it — they type `client.data` differently, and two of them
 * do not type it at all.
 */
export interface WsPrincipal {
  userId?: string;
  role?: string;
  tenantId?: string | null;
  customerId?: string | null;
}

export interface DeviceAuthorizationResult {
  /** Ids the caller may join rooms for. */
  allowed: string[];
  /** Ids refused: another tenant's, another customer's, absent, or malformed. */
  refused: string[];
}

/**
 * Postgres raises `invalid input syntax for type uuid` on a malformed id, so
 * an unfiltered `In([...])` turns a bad subscribe payload into a 500 — and
 * into a crash loop if a widget retries. Non-uuids are refused before the
 * query, not routed to the database to be rejected there.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WsSubscriptionAuthorizer {
  private readonly logger = new Logger(WsSubscriptionAuthorizer.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  private principal(client: { data?: any }): WsPrincipal {
    const data = client?.data ?? {};
    return {
      userId: data.userId,
      role: data.role,
      tenantId: data.tenantId ?? null,
      customerId: data.customerId ?? null,
    };
  }

  /**
   * Partition the requested device ids into those this socket may subscribe
   * to and those it may not. Never throws: a failure to prove access is a
   * refusal, so a database blip denies rather than opening up.
   */
  async authorizeDevices(
    client: { data?: any; id?: string },
    deviceIds: readonly string[] | undefined | null,
  ): Promise<DeviceAuthorizationResult> {
    const requested = Array.from(
      new Set((deviceIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    );
    if (requested.length === 0) {
      return { allowed: [], refused: [] };
    }

    const wellFormed = requested.filter((id) => UUID_RE.test(id));
    const malformed = requested.filter((id) => !UUID_RE.test(id));

    const { role, tenantId, customerId } = this.principal(client);

    // Cross-tenant by design. Still refuses malformed ids, which are a bug on
    // the caller's side whoever is asking.
    if (role === UserRole.SUPER_ADMIN) {
      return { allowed: wellFormed, refused: malformed };
    }

    // A token with no tenant claim that is not a super admin cannot be scoped
    // to anything, so it is scoped to nothing.
    if (!tenantId) {
      this.logger.warn(
        `Refusing ${requested.length} device subscription(s) for socket ${client?.id}: ` +
          `role=${role ?? 'unknown'} carries no tenantId`,
      );
      return { allowed: [], refused: requested };
    }

    if (wellFormed.length === 0) {
      return { allowed: [], refused: malformed };
    }

    try {
      const where: Record<string, unknown> = {
        id: In(wellFormed),
        tenantId,
      };
      // Only narrow by customer when the token actually carries one. Tenant
      // admins have no customerId and must keep tenant-wide visibility.
      if (customerId) {
        where.customerId = customerId;
      }

      const rows = await this.deviceRepository.find({
        where: where as any,
        select: { id: true },
      });

      const visible = new Set(rows.map((row) => row.id));
      const allowed = wellFormed.filter((id) => visible.has(id));
      const refused = [...malformed, ...wellFormed.filter((id) => !visible.has(id))];

      if (refused.length > 0) {
        this.logger.warn(
          `Socket ${client?.id} (tenant=${tenantId}${customerId ? `, customer=${customerId}` : ''}) ` +
            `was refused ${refused.length} of ${requested.length} device subscription(s)`,
        );
      }

      return { allowed, refused };
    } catch (error: any) {
      // Fail closed. An authorizer that cannot answer must not guess "yes".
      this.logger.error(
        `Device subscription authorization failed for socket ${client?.id}: ${error?.message}`,
      );
      return { allowed: [], refused: requested };
    }
  }

  /** Convenience wrapper for the single-device handlers. */
  async canSubscribeToDevice(
    client: { data?: any; id?: string },
    deviceId: string | undefined | null,
  ): Promise<boolean> {
    if (!deviceId) return false;
    const { allowed } = await this.authorizeDevices(client, [deviceId]);
    return allowed.length === 1;
  }

  /**
   * `customer:<id>` rooms carry every alarm raised for that customer, so the
   * claim has to match. No database read is needed: the token's own
   * customerId is the authority, and a tenant admin may watch any customer
   * inside their tenant — which is what the tenant-scoped alarm broadcast
   * already assumes.
   */
  canSubscribeToCustomer(
    client: { data?: any; id?: string },
    customerId: string | undefined | null,
  ): boolean {
    if (!customerId || !UUID_RE.test(customerId)) return false;

    const principal = this.principal(client);
    if (principal.role === UserRole.SUPER_ADMIN) return true;
    if (!principal.tenantId) return false;

    // A customer-scoped account may only watch its own customer.
    if (principal.customerId) {
      return principal.customerId === customerId;
    }

    // Tenant-scoped roles (tenant admin and friends) may watch customers of
    // their tenant. The room itself is only ever fed by that tenant's alarms.
    return (
      principal.role === UserRole.TENANT_ADMIN ||
      principal.role === UserRole.USER ||
      principal.role === UserRole.CUSTOMER
    );
  }
}
