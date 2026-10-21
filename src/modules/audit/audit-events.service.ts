// src/modules/audit/audit-events.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The event-driven half of the audit log
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Eighteen handlers, and until this change not one of them produced a row.
 * Two independent defects, either of which alone was enough:
 *
 *  1. **Ten events had no emitter at all.** `grep "emit('<name>'" src` returned
 *     zero for `user.login`, `user.login.failed`, `user.logout`,
 *     `user.role.changed`, `device.created`, `device.updated`,
 *     `device.deleted`, `device.disconnected` and `device.command.sent`. So
 *     authentication — who logged in, who failed to, who was given which role
 *     — was not recorded anywhere. Emitters now exist in `AuthService`,
 *     `UsersService`, `DevicesService` and `GatewayService`.
 *
 *  2. **The eight that DID fire were emitted with the wrong payload shape.**
 *     `UsersService.create()` emits `{ user }`; `AlarmsService` emits
 *     `{ alarm }`. Every handler below read `payload.tenantId`, which in those
 *     payloads is `undefined` — and `audit_logs.tenantId` is NOT NULL, so the
 *     INSERT threw. `EventEmitter2.emit()` discards the returned promise, so
 *     the rejection surfaced as an unhandled rejection rather than an error
 *     anyone could see. A handler that throws is silently a handler that does
 *     nothing.
 *
 * Both are addressed structurally rather than one handler at a time:
 *
 *  • `resolveTenantId()` falls back to the entity carried in the payload, so a
 *    caller that emits `{ user }` or `{ alarm }` still produces a scoped row.
 *    Emitters are not trusted to have been updated.
 *  • `record()` is the only write path. It drops (with a warning) rather than
 *    throws when there is no tenant to scope the row to, and it swallows
 *    repository errors. An audit write must never fail the operation it
 *    describes, and it must never become an unhandled rejection.
 */
@Injectable()
export class AuditEventsService {
  private readonly logger = new Logger(AuditEventsService.name);

  constructor(private readonly auditService: AuditService) {}

  // ============================================
  // WRITE PATH
  // ============================================

  /**
   * Pull a tenant id out of whatever shape the emitter actually sent.
   *
   * Listed widest-to-narrowest: an explicit `tenantId` on the payload wins,
   * then the entity the event is about. This is defensive on purpose — the
   * emitters in this repo were written independently of these handlers and
   * three of them still send only the entity.
   */
  private resolveTenantId(payload: any): string | undefined {
    return (
      payload?.tenantId ||
      payload?.user?.tenantId ||
      payload?.device?.tenantId ||
      payload?.alarm?.tenantId ||
      payload?.entity?.tenantId ||
      undefined
    );
  }

  private resolveCustomerId(payload: any): string | undefined {
    return (
      payload?.customerId ||
      payload?.user?.customerId ||
      payload?.device?.customerId ||
      payload?.alarm?.customerId ||
      undefined
    );
  }

  /**
   * The single write path for every handler in this file.
   *
   * `audit_logs.tenantId` is NOT NULL and carries a relation to `tenants`, so
   * a row with no tenant cannot be stored — and could not be read back if it
   * were, because every audit read is tenant-scoped (`applyRoleBasedFilters`).
   * An unattributable event is therefore logged to the application log and
   * dropped; the request itself is still recorded in `api_logs` by
   * `ApiLoggingMiddleware`, which has no such constraint.
   */
  private async record(
    event: string,
    entry: {
      tenantId?: string;
      action: AuditAction;
      entityType: AuditEntityType;
      [key: string]: any;
    },
  ): Promise<void> {
    if (!entry.tenantId) {
      this.logger.warn(
        `audit event '${event}' could not be attributed to a tenant — ` +
          `dropped (action=${entry.action}, entity=${entry.entityType}, ` +
          `subject=${entry.entityId ?? entry.userEmail ?? 'unknown'})`,
      );
      return;
    }

    try {
      await this.auditService.logAction(
        entry as Parameters<AuditService['logAction']>[0],
      );
    } catch (error) {
      // Never rethrow. This runs inside an EventEmitter2 listener whose
      // promise nobody awaits, so a throw here is an unhandled rejection that
      // takes the process down under `--unhandled-rejections=throw`.
      this.logger.error(
        `Failed to write audit row for '${event}' (action=${entry.action})`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // ============================================
  // USER EVENTS
  // ============================================

  @OnEvent('user.created')
  async handleUserCreated(payload: {
    user: any;
    createdBy?: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('user.created', {
      userId: payload.createdBy?.id,
      userName: payload.createdBy?.name,
      userEmail: payload.createdBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.CREATE,
      entityType: AuditEntityType.USER,
      entityId: payload.user?.id,
      entityName: payload.user?.name,
      description: `User '${payload.user?.email}' created`,
      metadata: {
        role: payload.user?.role,
        email: payload.user?.email,
      },
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.updated')
  async handleUserUpdated(payload: {
    user: any;
    updatedBy?: any;
    tenantId?: string;
    customerId?: string;
    changes?: any;
  }) {
    await this.record('user.updated', {
      userId: payload.updatedBy?.id,
      userName: payload.updatedBy?.name,
      userEmail: payload.updatedBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.USER,
      entityId: payload.user?.id,
      entityName: payload.user?.name,
      description: `User '${payload.user?.email}' updated`,
      changes: payload.changes,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.deleted')
  async handleUserDeleted(payload: {
    userId: string;
    userEmail?: string;
    deletedBy?: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('user.deleted', {
      userId: payload.deletedBy?.id,
      userName: payload.deletedBy?.name,
      userEmail: payload.deletedBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.DELETE,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `User '${payload.userEmail ?? payload.userId}' deleted`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('user.login')
  async handleUserLogin(payload: {
    userId: string;
    userName?: string;
    email: string;
    tenantId?: string;
    customerId?: string;
    ipAddress?: string;
    userAgent?: string;
    loginMethod?: string;
  }) {
    await this.record('user.login', {
      userId: payload.userId,
      userName: payload.userName,
      userEmail: payload.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.LOGIN,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `User '${payload.email}' logged in`,
      metadata: payload.loginMethod ? { method: payload.loginMethod } : undefined,
      ipAddress: payload.ipAddress,
      userAgent: payload.userAgent,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.login.failed')
  async handleUserLoginFailed(payload: {
    email: string;
    userId?: string;
    tenantId?: string;
    customerId?: string;
    ipAddress?: string;
    userAgent?: string;
    reason?: string;
  }) {
    // No `|| 'system'` fallback: `tenantId` carries a relation to `tenants`,
    // so a sentinel string is either an FK violation or a row no tenant-scoped
    // read can ever return. An attempt against an email that matches no
    // account has no tenant by definition and is dropped here — it is still
    // visible in `api_logs`. An attempt against a REAL account (the case that
    // matters for credential stuffing) always resolves, because the emitter
    // has the user row in hand.
    await this.record('user.login.failed', {
      userId: payload.userId,
      userEmail: payload.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.LOGIN_FAILED,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `Failed login attempt for '${payload.email}'${payload.reason ? `: ${payload.reason}` : ''}`,
      ipAddress: payload.ipAddress,
      userAgent: payload.userAgent,
      severity: AuditSeverity.WARNING,
      success: false,
      errorMessage: payload.reason,
    });
  }

  @OnEvent('user.logout')
  async handleUserLogout(payload: {
    userId: string;
    userName?: string;
    email?: string;
    tenantId?: string;
    customerId?: string;
    ipAddress?: string;
    userAgent?: string;
    scope?: 'session' | 'all-devices';
  }) {
    await this.record('user.logout', {
      userId: payload.userId,
      userName: payload.userName,
      userEmail: payload.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.LOGOUT,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description:
        payload.scope === 'all-devices'
          ? `User '${payload.email ?? payload.userId}' logged out of all devices`
          : `User '${payload.email ?? payload.userId}' logged out`,
      metadata: payload.scope ? { scope: payload.scope } : undefined,
      ipAddress: payload.ipAddress,
      userAgent: payload.userAgent,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.password.changed')
  async handlePasswordChanged(payload: {
    userId: string;
    userName?: string;
    email?: string;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('user.password.changed', {
      userId: payload.userId,
      userName: payload.userName,
      userEmail: payload.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.PASSWORD_CHANGE,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `Password changed for user '${payload.email ?? payload.userId}'`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('user.role.changed')
  async handleRoleChanged(payload: {
    userId: string;
    userName?: string;
    email?: string;
    tenantId?: string;
    customerId?: string;
    oldRole: string;
    newRole: string;
    changedBy?: any;
  }) {
    await this.record('user.role.changed', {
      userId: payload.changedBy?.id,
      userName: payload.changedBy?.name,
      userEmail: payload.changedBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.ROLE_CHANGE,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      entityName: payload.email,
      description: `User role changed from ${payload.oldRole} to ${payload.newRole}`,
      changes: {
        before: { role: payload.oldRole },
        after: { role: payload.newRole },
      },
      severity: AuditSeverity.WARNING,
    });
  }

  // ============================================
  // DEVICE EVENTS
  // ============================================

  @OnEvent('device.created')
  async handleDeviceCreated(payload: {
    device: any;
    createdBy?: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('device.created', {
      userId: payload.createdBy?.id,
      userName: payload.createdBy?.name,
      userEmail: payload.createdBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.CREATE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.device?.id,
      entityName: payload.device?.name,
      description: `Device '${payload.device?.name}' created`,
      metadata: {
        deviceKey: payload.device?.deviceKey,
        protocol: payload.device?.protocol,
        deviceProfileId: payload.device?.deviceProfileId,
      },
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.updated')
  async handleDeviceUpdated(payload: {
    device: any;
    updatedBy?: any;
    tenantId?: string;
    customerId?: string;
    changes?: any;
  }) {
    await this.record('device.updated', {
      userId: payload.updatedBy?.id,
      userName: payload.updatedBy?.name,
      userEmail: payload.updatedBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.device?.id,
      entityName: payload.device?.name,
      description: `Device '${payload.device?.name}' updated`,
      changes: payload.changes,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.deleted')
  async handleDeviceDeleted(payload: {
    deviceId: string;
    deviceName?: string;
    deletedBy?: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('device.deleted', {
      userId: payload.deletedBy?.id,
      userName: payload.deletedBy?.name,
      userEmail: payload.deletedBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.DELETE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId,
      entityName: payload.deviceName,
      description: `Device '${payload.deviceName ?? payload.deviceId}' deleted`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('device.connected')
  async handleDeviceConnected(payload: {
    deviceId?: string;
    deviceName?: string;
    device?: any;
    tenantId?: string;
    customerId?: string;
  }) {
    // `DevicesService.handleDeviceOnline()` emits `{ device, user }`, not the
    // flat shape this handler was written for — hence the fallbacks.
    await this.record('device.connected', {
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.DEVICE_CONNECT,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId ?? payload.device?.id,
      entityName: payload.deviceName ?? payload.device?.name,
      description: `Device '${payload.deviceName ?? payload.device?.name}' connected`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.disconnected')
  async handleDeviceDisconnected(payload: {
    deviceId?: string;
    deviceName?: string;
    device?: any;
    tenantId?: string;
    customerId?: string;
    reason?: string;
  }) {
    await this.record('device.disconnected', {
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.DEVICE_DISCONNECT,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId ?? payload.device?.id,
      entityName: payload.deviceName ?? payload.device?.name,
      description: `Device '${payload.deviceName ?? payload.device?.name}' disconnected`,
      metadata: payload.reason ? { reason: payload.reason } : undefined,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('device.command.sent')
  async handleDeviceCommandSent(payload: {
    deviceId?: string;
    deviceName?: string;
    deviceKey?: string;
    device?: any;
    tenantId?: string;
    customerId?: string;
    command: string;
    params?: Record<string, any>;
    sentBy?: any;
  }) {
    await this.record('device.command.sent', {
      userId: payload.sentBy?.id,
      userName: payload.sentBy?.name,
      userEmail: payload.sentBy?.email,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.DEVICE_COMMAND,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId ?? payload.device?.id,
      entityName: payload.deviceName ?? payload.device?.name,
      description: `Command '${payload.command}' sent to device '${payload.deviceName ?? payload.deviceKey}'`,
      metadata: {
        command: payload.command,
        params: payload.params,
        deviceKey: payload.deviceKey ?? payload.device?.deviceKey,
      },
      severity: AuditSeverity.INFO,
    });
  }

  // ============================================
  // ALARM EVENTS
  // ============================================

  @OnEvent('alarm.created')
  async handleAlarmCreated(payload: {
    alarm: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('alarm.created', {
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.CREATE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarm?.id,
      entityName: payload.alarm?.name,
      description: `Alarm '${payload.alarm?.name}' created`,
      metadata: {
        severity: payload.alarm?.severity,
        deviceId: payload.alarm?.deviceId,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('alarm.acknowledged')
  async handleAlarmAcknowledged(payload: {
    alarm: any;
    tenantId?: string;
    customerId?: string;
    userId?: string;
  }) {
    await this.record('alarm.acknowledged', {
      userId: payload.userId,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarm?.id,
      entityName: payload.alarm?.name,
      description: `Alarm '${payload.alarm?.name}' acknowledged`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('alarm.cleared')
  async handleAlarmCleared(payload: {
    alarm: any;
    tenantId?: string;
    customerId?: string;
  }) {
    await this.record('alarm.cleared', {
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarm?.id,
      entityName: payload.alarm?.name,
      description: `Alarm '${payload.alarm?.name}' cleared`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('alarm.resolved')
  async handleAlarmResolved(payload: {
    alarm: any;
    tenantId?: string;
    customerId?: string;
    userId?: string;
  }) {
    await this.record('alarm.resolved', {
      userId: payload.userId,
      tenantId: this.resolveTenantId(payload),
      customerId: this.resolveCustomerId(payload),
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarm?.id,
      entityName: payload.alarm?.name,
      description: `Alarm '${payload.alarm?.name}' resolved`,
      metadata: { resolutionNote: payload.alarm?.resolutionNote },
      severity: AuditSeverity.INFO,
    });
  }

  // Everything else — tenants, dashboards, assets, rule chains, integrations,
  // subscriptions, payments, roles, groups, firmware and the rest — is covered
  // by the `@Audit()` interceptor on the state-changing routes rather than by
  // a handler per entity here. See `scripts/add-audit-decorators.py`.
}
