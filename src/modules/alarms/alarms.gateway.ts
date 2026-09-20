// src/modules/alarms/gateways/alarms.gateway.ts
import { websocketCorsOrigin } from '@common/utils/websocket-cors';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsJwtGuard } from '@common/guards/ws-jwt.guard';
import { Alarm } from '@modules/index.entities';

@WebSocketGateway({
  namespace: '/alarms',
  cors: {
    origin: websocketCorsOrigin(),
    credentials: true,
  },
})
export class AlarmsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AlarmsGateway.name);

  private userSockets: Map<string, Set<string>>   = new Map();
  private tenantSockets: Map<string, Set<string>> = new Map();
  private customerSockets: Map<string, Set<string>> = new Map();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

    afterInit(server: Server) {
    this.logger.log('🚨 AlarmsGateway initialized on /alarms');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONNECTION
  // ══════════════════════════════════════════════════════════════════════════

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to alarms: ${client.id}`);
    this.logger.log(`Auth received: ${JSON.stringify(client.handshake.auth)}`);


    // ── Resolve userId / tenantId / customerId ─────────────────────────────
    // Clients can pass these directly in handshake.auth OR we decode from JWT.
    // JWT decode is the fallback so any client with a valid token works.
    let userId     = client.handshake.auth?.userId     as string | undefined;
    let tenantId   = client.handshake.auth?.tenantId   as string | undefined;
    let customerId = client.handshake.auth?.customerId as string | undefined;

    const token = client.handshake.auth?.token as string | undefined;
    this.logger.log(`Token present: ${!!token}, length: ${token?.length ?? 0}`);


    if (token && (!userId || !tenantId)) {
      try {
        const payload: any = this.jwtService.verify(token, {
          secret: this.configService.get<string>('JWT_SECRET'),
        });
        // sub is the standard JWT subject claim (= user id)
        userId     = userId     ?? (payload.sub ?? payload.id);
        tenantId   = tenantId   ?? payload.tenantId;
        customerId = customerId ?? payload.customerId ?? undefined;

        this.logger.log(
          `JWT decoded for ${client.id} — userId: ${userId}, tenantId: ${tenantId}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `JWT decode failed for client ${client.id}: ${err.message}`,
        );
        // Don't disconnect — device rooms still work without auth
      }
    }

    // ── Join rooms ─────────────────────────────────────────────────────────
    if (userId) {
      if (!this.userSockets.has(userId)) this.userSockets.set(userId, new Set());
      this.userSockets.get(userId)!.add(client.id);
      client.join(`user:${userId}`);
      this.logger.log(`User ${userId} joined alarms room`);
    }

    if (tenantId) {
      if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
      this.tenantSockets.get(tenantId)!.add(client.id);
      client.join(`tenant:${tenantId}`);
      this.logger.log(`Tenant ${tenantId} joined alarms room`);
    }

    if (customerId) {
      if (!this.customerSockets.has(customerId)) this.customerSockets.set(customerId, new Set());
      this.customerSockets.get(customerId)!.add(client.id);
      client.join(`customer:${customerId}`);
      this.logger.log(`Customer ${customerId} joined alarms room`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from alarms: ${client.id}`);

    // We stored the resolved values in the socket rooms — clean up by
    // iterating our maps rather than re-reading handshake (which may be stale).
    this.userSockets.forEach((sockets, userId) => {
      if (sockets.has(client.id)) {
        sockets.delete(client.id);
        if (sockets.size === 0) this.userSockets.delete(userId);
      }
    });

    this.tenantSockets.forEach((sockets, tenantId) => {
      if (sockets.has(client.id)) {
        sockets.delete(client.id);
        if (sockets.size === 0) this.tenantSockets.delete(tenantId);
      }
    });

    this.customerSockets.forEach((sockets, customerId) => {
      if (sockets.has(client.id)) {
        sockets.delete(client.id);
        if (sockets.size === 0) this.customerSockets.delete(customerId);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTIONS (client-initiated)
  // ══════════════════════════════════════════════════════════════════════════

  @SubscribeMessage('subscribe:device')
  @UseGuards(WsJwtGuard)
  handleSubscribeDevice(client: Socket, deviceId: string) {
    client.join(`device:${deviceId}`);
    this.logger.log(`Client ${client.id} subscribed to device ${deviceId} alarms`);
    return { event: 'subscribed', data: { deviceId } };
  }

  @SubscribeMessage('unsubscribe:device')
  @UseGuards(WsJwtGuard)
  handleUnsubscribeDevice(client: Socket, deviceId: string) {
    client.leave(`device:${deviceId}`);
    this.logger.log(`Client ${client.id} unsubscribed from device ${deviceId} alarms`);
    return { event: 'unsubscribed', data: { deviceId } };
  }

  @SubscribeMessage('subscribe:customer')
  @UseGuards(WsJwtGuard)
  handleSubscribeCustomer(client: Socket, customerId: string) {
    client.join(`customer:${customerId}`);
    this.logger.log(`Client ${client.id} subscribed to customer ${customerId} alarms`);
    return { event: 'subscribed', data: { customerId } };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT BROADCASTS (server-initiated via EventEmitter2)
  // ══════════════════════════════════════════════════════════════════════════

  @OnEvent('alarm.triggered')
  handleAlarmTriggered(payload: { alarm: Alarm }) {
    const { alarm } = payload;
    this.logger.log(`Broadcasting alarm triggered: ${alarm.id} to tenant:${alarm.tenantId}`);

    const eventData = {
      id:           alarm.id,
      name:         alarm.name,
      severity:     alarm.severity,
      status:       alarm.status,
      tbStatus:     alarm.tbStatus,
      message:      alarm.message,
      deviceId:     alarm.deviceId,
      customerId:   alarm.customerId,
      currentValue: alarm.currentValue,
      triggeredAt:  alarm.triggeredAt,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:triggered', eventData);

    if (alarm.customerId) {
      this.server.to(`customer:${alarm.customerId}`).emit('alarm:triggered', eventData);
    }
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:triggered', eventData);
    }
    if (alarm.createdBy) {
      this.server.to(`user:${alarm.createdBy}`).emit('alarm:triggered', eventData);
    }
  }

  /**
   * A newly created alarm rule. AlarmsService emits alarm.created on every
   * create() but nothing was listening, so a rule added from another session
   * never appeared until the page was reloaded.
   */
  @OnEvent('alarm.created')
  handleAlarmCreated(payload: { alarm: Alarm }) {
    const { alarm } = payload;
    this.logger.log(`Broadcasting alarm created: ${alarm.id}`);

    const eventData = {
      id:       alarm.id,
      name:     alarm.name,
      severity: alarm.severity,
      status:   alarm.status,
      tbStatus: alarm.tbStatus,
      deviceId: alarm.deviceId,
      isEnabled: alarm.isEnabled,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:created', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:created', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:created', eventData);
  }

  @OnEvent('alarm.assigned')
  handleAlarmAssigned(payload: { alarm: Alarm; userId: string | null }) {
    const { alarm, userId } = payload;
    this.logger.log(`Broadcasting alarm assigned: ${alarm.id} → ${userId ?? 'unassigned'}`);

    const eventData = {
      id:         alarm.id,
      name:       alarm.name,
      status:     alarm.status,
      tbStatus:   alarm.tbStatus,
      assignedTo: alarm.assignedTo ?? null,
      assignedAt: alarm.assignedAt ?? null,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:assigned', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:assigned', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:assigned', eventData);
    // The new assignee gets it directly, even with no tenant room joined.
    if (userId) this.server.to(`user:${userId}`).emit('alarm:assigned', eventData);
  }

  @OnEvent('alarm.acknowledged')
  handleAlarmAcknowledged(payload: { alarm: Alarm; userId: string }) {
    const { alarm } = payload;
    this.logger.log(`Broadcasting alarm acknowledged: ${alarm.id}`);

    const eventData = {
      id:              alarm.id,
      name:            alarm.name,
      status:          alarm.status,
      tbStatus:        alarm.tbStatus,
      acknowledgedAt:  alarm.acknowledgedAt,
      acknowledgedBy:  alarm.acknowledgedBy,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:acknowledged', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:acknowledged', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:acknowledged', eventData);
  }

  /**
   * Emitted by AlarmConsumer after a level is claimed and dispatched, so the
   * operator UI can surface a rising alarm without polling.
   */
  @OnEvent('alarm.escalated')
  handleAlarmEscalated(payload: { alarm: Alarm; level: number }) {
    const { alarm, level } = payload;
    this.logger.log(`Broadcasting alarm escalated: ${alarm.id} → L${level}`);

    const eventData = {
      id:              alarm.id,
      name:            alarm.name,
      severity:        alarm.severity,
      status:          alarm.status,
      tbStatus:        alarm.tbStatus,
      escalationLevel: alarm.escalationLevel,
      escalatedAt:     alarm.escalatedAt,
      deviceId:        alarm.deviceId,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:escalated', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:escalated', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:escalated', eventData);
    if (alarm.assignedTo) this.server.to(`user:${alarm.assignedTo}`).emit('alarm:escalated', eventData);
  }

  @OnEvent('alarm.cleared')
  handleAlarmCleared(payload: { alarm: Alarm }) {
    const { alarm } = payload;
    this.logger.log(`Broadcasting alarm cleared: ${alarm.id}`);

    const eventData = {
      id:        alarm.id,
      name:      alarm.name,
      status:    alarm.status,
      tbStatus:  alarm.tbStatus,
      clearedAt: alarm.clearedAt,
      clearedBy: alarm.clearedBy ?? null,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:cleared', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:cleared', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:cleared', eventData);
  }

  @OnEvent('alarm.resolved')
  handleAlarmResolved(payload: { alarm: Alarm; userId: string }) {
    const { alarm } = payload;
    this.logger.log(`Broadcasting alarm resolved: ${alarm.id}`);

    const eventData = {
      id:             alarm.id,
      name:           alarm.name,
      status:         alarm.status,
      resolvedAt:     alarm.resolvedAt,
      resolvedBy:     alarm.resolvedBy,
      resolutionNote: alarm.resolutionNote,
    };

    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:resolved', eventData);
    if (alarm.customerId) this.server.to(`customer:${alarm.customerId}`).emit('alarm:resolved', eventData);
    if (alarm.deviceId)   this.server.to(`device:${alarm.deviceId}`).emit('alarm:resolved', eventData);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANUAL EMIT HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
  }

  emitToCustomer(customerId: string, event: string, data: any) {
    this.server.to(`customer:${customerId}`).emit(event, data);
  }

  emitToDevice(deviceId: string, event: string, data: any) {
    this.server.to(`device:${deviceId}`).emit(event, data);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATS
  // ══════════════════════════════════════════════════════════════════════════

  getConnectedUsersCount(): number  { return this.userSockets.size; }
  getConnectedTenantsCount(): number { return this.tenantSockets.size; }

  isUserConnected(userId: string): boolean {
    return this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0;
  }

  isTenantConnected(tenantId: string): boolean {
    return this.tenantSockets.has(tenantId) && this.tenantSockets.get(tenantId)!.size > 0;
  }

  getTenantConnectedUsers(tenantId: string): string[] {
    const connectedUserIds: string[] = [];
    this.userSockets.forEach((sockets, userId) => {
      const inTenant = Array.from(sockets).some(socketId => {
        const socket = this.server.sockets.sockets.get(socketId);
        return socket?.handshake.auth?.tenantId === tenantId;
      });
      if (inTenant) connectedUserIds.push(userId);
    });
    return connectedUserIds;
  }
}