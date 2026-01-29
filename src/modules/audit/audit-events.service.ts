// src/modules/audit/audit-events.service.ts
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@Injectable()
export class AuditEventsService {
  constructor(private readonly auditService: AuditService) {}

  // ============================================
  // USER EVENTS
  // ============================================

  @OnEvent('user.created')
  async handleUserCreated(payload: {
    user: any;
    createdBy?: any;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.createdBy?.id,
      userName: payload.createdBy?.name,
      userEmail: payload.createdBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.CREATE,
      entityType: AuditEntityType.USER,
      entityId: payload.user.id,
      entityName: payload.user.name,
      description: `User '${payload.user.email}' created`,
      metadata: {
        role: payload.user.role,
        email: payload.user.email,
      },
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.updated')
  async handleUserUpdated(payload: {
    user: any;
    updatedBy?: any;
    tenantId: string;
    changes?: any;
  }) {
    await this.auditService.logAction({
      userId: payload.updatedBy?.id,
      userName: payload.updatedBy?.name,
      userEmail: payload.updatedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.USER,
      entityId: payload.user.id,
      entityName: payload.user.name,
      description: `User '${payload.user.email}' updated`,
      changes: payload.changes,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.deleted')
  async handleUserDeleted(payload: {
    userId: string;
    userEmail: string;
    deletedBy?: any;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.deletedBy?.id,
      userName: payload.deletedBy?.name,
      userEmail: payload.deletedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.DELETE,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `User '${payload.userEmail}' deleted`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('user.login')
  async handleUserLogin(payload: {
    userId: string;
    email: string;
    tenantId: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    await this.auditService.logAction({
      userId: payload.userId,
      userEmail: payload.email,
      tenantId: payload.tenantId,
      action: AuditAction.LOGIN,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `User '${payload.email}' logged in`,
      ipAddress: payload.ipAddress,
      userAgent: payload.userAgent,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.login.failed')
  async handleUserLoginFailed(payload: {
    email: string;
    tenantId?: string;
    ipAddress?: string;
    reason?: string;
  }) {
    await this.auditService.logAction({
      tenantId: payload.tenantId || 'system',
      userEmail: payload.email,
      action: AuditAction.LOGIN_FAILED,
      entityType: AuditEntityType.USER,
      description: `Failed login attempt for '${payload.email}'${payload.reason ? `: ${payload.reason}` : ''}`,
      ipAddress: payload.ipAddress,
      severity: AuditSeverity.WARNING,
      success: false,
      errorMessage: payload.reason,
    });
  }

  @OnEvent('user.logout')
  async handleUserLogout(payload: {
    userId: string;
    email: string;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.userId,
      userEmail: payload.email,
      tenantId: payload.tenantId,
      action: AuditAction.LOGOUT,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `User '${payload.email}' logged out`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('user.password.changed')
  async handlePasswordChanged(payload: {
    userId: string;
    email: string;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.userId,
      userEmail: payload.email,
      tenantId: payload.tenantId,
      action: AuditAction.PASSWORD_CHANGE,
      entityType: AuditEntityType.USER,
      entityId: payload.userId,
      description: `Password changed for user '${payload.email}'`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('user.role.changed')
  async handleRoleChanged(payload: {
    userId: string;
    email: string;
    tenantId: string;
    oldRole: string;
    newRole: string;
    changedBy?: any;
  }) {
    await this.auditService.logAction({
      userId: payload.changedBy?.id,
      userName: payload.changedBy?.name,
      userEmail: payload.changedBy?.email,
      tenantId: payload.tenantId,
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
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.createdBy?.id,
      userName: payload.createdBy?.name,
      userEmail: payload.createdBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.CREATE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.device.id,
      entityName: payload.device.name,
      description: `Device '${payload.device.name}' created`,
      metadata: {
        deviceKey: payload.device.deviceKey,
        profileId: payload.device.profileId,
      },
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.updated')
  async handleDeviceUpdated(payload: {
    device: any;
    updatedBy?: any;
    tenantId: string;
    changes?: any;
  }) {
    await this.auditService.logAction({
      userId: payload.updatedBy?.id,
      userName: payload.updatedBy?.name,
      userEmail: payload.updatedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.device.id,
      entityName: payload.device.name,
      description: `Device '${payload.device.name}' updated`,
      changes: payload.changes,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.deleted')
  async handleDeviceDeleted(payload: {
    deviceId: string;
    deviceName: string;
    deletedBy?: any;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      userId: payload.deletedBy?.id,
      userName: payload.deletedBy?.name,
      userEmail: payload.deletedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.DELETE,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId,
      entityName: payload.deviceName,
      description: `Device '${payload.deviceName}' deleted`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('device.connected')
  async handleDeviceConnected(payload: {
    deviceId: string;
    deviceName: string;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      tenantId: payload.tenantId,
      action: AuditAction.DEVICE_CONNECT,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId,
      entityName: payload.deviceName,
      description: `Device '${payload.deviceName}' connected`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('device.disconnected')
  async handleDeviceDisconnected(payload: {
    deviceId: string;
    deviceName: string;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      tenantId: payload.tenantId,
      action: AuditAction.DEVICE_DISCONNECT,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId,
      entityName: payload.deviceName,
      description: `Device '${payload.deviceName}' disconnected`,
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('device.command.sent')
  async handleDeviceCommandSent(payload: {
    deviceId: string;
    deviceName: string;
    tenantId: string;
    command: string;
    sentBy?: any;
  }) {
    await this.auditService.logAction({
      userId: payload.sentBy?.id,
      userName: payload.sentBy?.name,
      userEmail: payload.sentBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.DEVICE_COMMAND,
      entityType: AuditEntityType.DEVICE,
      entityId: payload.deviceId,
      entityName: payload.deviceName,
      description: `Command '${payload.command}' sent to device '${payload.deviceName}'`,
      metadata: { command: payload.command },
      severity: AuditSeverity.INFO,
    });
  }

  // ============================================
  // ALARM EVENTS
  // ============================================

  @OnEvent('alarm.created')
  async handleAlarmCreated(payload: {
    alarm: any;
    tenantId: string;
  }) {
    await this.auditService.logAction({
      tenantId: payload.tenantId,
      action: AuditAction.ALARM_CREATE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarm.id,
      entityName: payload.alarm.name,
      description: `Alarm '${payload.alarm.name}' created`,
      metadata: {
        severity: payload.alarm.severity,
        deviceId: payload.alarm.deviceId,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  @OnEvent('alarm.acknowledged')
  async handleAlarmAcknowledged(payload: {
    alarmId: string;
    alarmName: string;
    tenantId: string;
    acknowledgedBy: any;
  }) {
    await this.auditService.logAction({
      userId: payload.acknowledgedBy?.id,
      userName: payload.acknowledgedBy?.name,
      userEmail: payload.acknowledgedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.ALARM_ACKNOWLEDGE,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarmId,
      entityName: payload.alarmName,
      description: `Alarm '${payload.alarmName}' acknowledged`,
      severity: AuditSeverity.INFO,
    });
  }

  @OnEvent('alarm.cleared')
  async handleAlarmCleared(payload: {
    alarmId: string;
    alarmName: string;
    tenantId: string;
    clearedBy?: any;
  }) {
    await this.auditService.logAction({
      userId: payload.clearedBy?.id,
      userName: payload.clearedBy?.name,
      userEmail: payload.clearedBy?.email,
      tenantId: payload.tenantId,
      action: AuditAction.ALARM_CLEAR,
      entityType: AuditEntityType.ALARM,
      entityId: payload.alarmId,
      entityName: payload.alarmName,
      description: `Alarm '${payload.alarmName}' cleared`,
      severity: AuditSeverity.INFO,
    });
  }

  // Add more event handlers for other modules (Assets, Dashboards, Customers, etc.)
}