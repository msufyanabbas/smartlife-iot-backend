// src/modules/alarms/gateways/alarms.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WsJwtGuard } from '@common/guards/ws-jwt.guard';
import { Alarm } from '@modules/index.entities';

/**
 * WebSocket Gateway for real-time alarm notifications
 * Sends alarm updates to connected clients
 */
@WebSocketGateway({
  namespace: 'alarms',
  cors: {
    origin: process.env.CORS_ORIGIN || '*', // Configure properly in production
    credentials: true,
  },
})
export class AlarmsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AlarmsGateway.name);
  
  // Track connections
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> socketIds
  private tenantSockets: Map<string, Set<string>> = new Map(); // tenantId -> socketIds
  private customerSockets: Map<string, Set<string>> = new Map(); // customerId -> socketIds

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to alarms: ${client.id}`);

    // Extract user info from client handshake (set by WS auth middleware)
    const userId = client.handshake.auth?.userId;
    const tenantId = client.handshake.auth?.tenantId;
    const customerId = client.handshake.auth?.customerId;

    if (userId) {
      // Track user socket
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join user-specific room
      client.join(`user:${userId}`);
      this.logger.log(`User ${userId} joined alarms room`);
    }

    if (tenantId) {
      // Track tenant socket
      if (!this.tenantSockets.has(tenantId)) {
        this.tenantSockets.set(tenantId, new Set());
      }
      this.tenantSockets.get(tenantId)!.add(client.id);

      // Join tenant-specific room
      client.join(`tenant:${tenantId}`);
      this.logger.log(`Tenant ${tenantId} joined alarms room`);
    }

    if (customerId) {
      // Track customer socket
      if (!this.customerSockets.has(customerId)) {
        this.customerSockets.set(customerId, new Set());
      }
      this.customerSockets.get(customerId)!.add(client.id);

      // Join customer-specific room
      client.join(`customer:${customerId}`);
      this.logger.log(`Customer ${customerId} joined alarms room`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from alarms: ${client.id}`);

    const userId = client.handshake.auth?.userId;
    const tenantId = client.handshake.auth?.tenantId;
    const customerId = client.handshake.auth?.customerId;

    // Clean up user sockets
    if (userId) {
      const sockets = this.userSockets.get(userId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    }

    // Clean up tenant sockets
    if (tenantId) {
      const sockets = this.tenantSockets.get(tenantId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.tenantSockets.delete(tenantId);
        }
      }
    }

    // Clean up customer sockets
    if (customerId) {
      const sockets = this.customerSockets.get(customerId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.customerSockets.delete(customerId);
        }
      }
    }
  }

  /**
   * Subscribe to device alarms
   */
  @SubscribeMessage('subscribe:device')
  @UseGuards(WsJwtGuard)
  handleSubscribeDevice(client: Socket, deviceId: string) {
    client.join(`device:${deviceId}`);
    this.logger.log(
      `Client ${client.id} subscribed to device ${deviceId} alarms`,
    );
    return { event: 'subscribed', data: { deviceId } };
  }

  /**
   * Unsubscribe from device alarms
   */
  @SubscribeMessage('unsubscribe:device')
  @UseGuards(WsJwtGuard)
  handleUnsubscribeDevice(client: Socket, deviceId: string) {
    client.leave(`device:${deviceId}`);
    this.logger.log(
      `Client ${client.id} unsubscribed from device ${deviceId} alarms`,
    );
    return { event: 'unsubscribed', data: { deviceId } };
  }

  /**
   * Subscribe to customer alarms
   */
  @SubscribeMessage('subscribe:customer')
  @UseGuards(WsJwtGuard)
  handleSubscribeCustomer(client: Socket, customerId: string) {
    client.join(`customer:${customerId}`);
    this.logger.log(
      `Client ${client.id} subscribed to customer ${customerId} alarms`,
    );
    return { event: 'subscribed', data: { customerId } };
  }

  /**
   * Listen for alarm triggered events
   */
  @OnEvent('alarm.triggered')
  handleAlarmTriggered(payload: { alarm: Alarm }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm triggered: ${alarm.id}`);

    const eventData = {
      id: alarm.id,
      name: alarm.name,
      severity: alarm.severity,
      status: alarm.status,
      message: alarm.message,
      deviceId: alarm.deviceId,
      customerId: alarm.customerId,
      currentValue: alarm.currentValue,
      triggeredAt: alarm.triggeredAt,
    };

    // Send to tenant room (all users in this tenant)
    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:triggered', eventData);

    // Send to customer room (if alarm has customerId)
    if (alarm.customerId) {
      this.server.to(`customer:${alarm.customerId}`).emit('alarm:triggered', eventData);
    }

    // Send to device-specific room
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:triggered', eventData);
    }

    // Send to creator (if they're connected)
    if (alarm.createdBy) {
      this.server.to(`user:${alarm.createdBy}`).emit('alarm:triggered', eventData);
    }
  }

  /**
   * Listen for alarm acknowledged events
   */
  @OnEvent('alarm.acknowledged')
  handleAlarmAcknowledged(payload: { alarm: Alarm; userId: string }) {
    const { alarm, userId } = payload;

    this.logger.log(`Broadcasting alarm acknowledged: ${alarm.id}`);

    const eventData = {
      id: alarm.id,
      name: alarm.name,
      status: alarm.status,
      acknowledgedAt: alarm.acknowledgedAt,
      acknowledgedBy: alarm.acknowledgedBy,
    };

    // Broadcast to tenant
    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:acknowledged', eventData);

    // Broadcast to customer
    if (alarm.customerId) {
      this.server.to(`customer:${alarm.customerId}`).emit('alarm:acknowledged', eventData);
    }

    // Broadcast to device
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:acknowledged', eventData);
    }
  }

  /**
   * Listen for alarm cleared events
   */
  @OnEvent('alarm.cleared')
  handleAlarmCleared(payload: { alarm: Alarm }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm cleared: ${alarm.id}`);

    const eventData = {
      id: alarm.id,
      name: alarm.name,
      status: alarm.status,
      clearedAt: alarm.clearedAt,
    };

    // Broadcast to tenant
    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:cleared', eventData);

    // Broadcast to customer
    if (alarm.customerId) {
      this.server.to(`customer:${alarm.customerId}`).emit('alarm:cleared', eventData);
    }

    // Broadcast to device
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:cleared', eventData);
    }
  }

  /**
   * Listen for alarm resolved events
   */
  @OnEvent('alarm.resolved')
  handleAlarmResolved(payload: { alarm: Alarm; userId: string }) {
    const { alarm, userId } = payload;

    this.logger.log(`Broadcasting alarm resolved: ${alarm.id}`);

    const eventData = {
      id: alarm.id,
      name: alarm.name,
      status: alarm.status,
      resolvedAt: alarm.resolvedAt,
      resolvedBy: alarm.resolvedBy,
      resolutionNote: alarm.resolutionNote,
    };

    // Broadcast to tenant
    this.server.to(`tenant:${alarm.tenantId}`).emit('alarm:resolved', eventData);

    // Broadcast to customer
    if (alarm.customerId) {
      this.server.to(`customer:${alarm.customerId}`).emit('alarm:resolved', eventData);
    }

    // Broadcast to device
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:resolved', eventData);
    }
  }

  /**
   * Manually emit alarm update to specific user
   */
  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Manually emit alarm update to specific tenant
   */
  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
  }

  /**
   * Manually emit alarm update to specific customer
   */
  emitToCustomer(customerId: string, event: string, data: any) {
    this.server.to(`customer:${customerId}`).emit(event, data);
  }

  /**
   * Manually emit alarm update to specific device subscribers
   */
  emitToDevice(deviceId: string, event: string, data: any) {
    this.server.to(`device:${deviceId}`).emit(event, data);
  }

  /**
   * Get connected users count
   */
  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  /**
   * Get connected tenants count
   */
  getConnectedTenantsCount(): number {
    return this.tenantSockets.size;
  }

  /**
   * Check if user is connected
   */
  isUserConnected(userId: string): boolean {
    return (
      this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0
    );
  }

  /**
   * Check if tenant has any connected users
   */
  isTenantConnected(tenantId: string): boolean {
    return (
      this.tenantSockets.has(tenantId) &&
      this.tenantSockets.get(tenantId)!.size > 0
    );
  }

  /**
   * Get all connected user IDs for a tenant
   */
  getTenantConnectedUsers(tenantId: string): string[] {
    const connectedUserIds: string[] = [];
    
    this.userSockets.forEach((sockets, userId) => {
      // Check if any of the user's sockets are in the tenant room
      const userSocketsInTenant = Array.from(sockets).some(socketId => {
        const socket = this.server.sockets.sockets.get(socketId);
        return socket?.handshake.auth?.tenantId === tenantId;
      });
      
      if (userSocketsInTenant) {
        connectedUserIds.push(userId);
      }
    });
    
    return connectedUserIds;
  }
}