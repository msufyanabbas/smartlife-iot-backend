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
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { Alarm } from './entities/alarm.entity';

/**
 * WebSocket Gateway for real-time alarm notifications
 * Sends alarm updates to connected clients
 */
@WebSocketGateway({
  namespace: 'alarms',
  cors: {
    origin: '*', // Configure properly in production
  },
})
export class AlarmsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AlarmsGateway.name);
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> socketIds

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to alarms: ${client.id}`);

    // Extract userId from client handshake (set by WS auth middleware)
    const userId = client.handshake.auth?.userId;

    if (userId) {
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join user-specific room
      client.join(`user:${userId}`);
      this.logger.log(`User ${userId} joined alarms room`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from alarms: ${client.id}`);

    const userId = client.handshake.auth?.userId;
    if (userId) {
      const sockets = this.userSockets.get(userId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
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
   * Listen for alarm triggered events
   */
  @OnEvent('alarm.triggered')
  handleAlarmTriggered(payload: { alarm: Alarm }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm triggered: ${alarm.id}`);

    // Send to user's room
    this.server.to(`user:${alarm.userId}`).emit('alarm:triggered', {
      id: alarm.id,
      name: alarm.name,
      severity: alarm.severity,
      message: alarm.message,
      deviceId: alarm.deviceId,
      currentValue: alarm.currentValue,
      triggeredAt: alarm.triggeredAt,
    });

    // Send to device-specific room
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:triggered', {
        id: alarm.id,
        name: alarm.name,
        severity: alarm.severity,
        message: alarm.message,
        currentValue: alarm.currentValue,
        triggeredAt: alarm.triggeredAt,
      });
    }
  }

  /**
   * Listen for alarm acknowledged events
   */
  @OnEvent('alarm.acknowledged')
  handleAlarmAcknowledged(payload: { alarm: Alarm; userId: string }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm acknowledged: ${alarm.id}`);

    this.server.to(`user:${alarm.userId}`).emit('alarm:acknowledged', {
      id: alarm.id,
      name: alarm.name,
      acknowledgedAt: alarm.acknowledgedAt,
      acknowledgedBy: alarm.acknowledgedBy,
    });

    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:acknowledged', {
        id: alarm.id,
        acknowledgedAt: alarm.acknowledgedAt,
      });
    }
  }

  /**
   * Listen for alarm cleared events
   */
  @OnEvent('alarm.cleared')
  handleAlarmCleared(payload: { alarm: Alarm }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm cleared: ${alarm.id}`);

    this.server.to(`user:${alarm.userId}`).emit('alarm:cleared', {
      id: alarm.id,
      name: alarm.name,
      clearedAt: alarm.clearedAt,
    });

    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:cleared', {
        id: alarm.id,
        clearedAt: alarm.clearedAt,
      });
    }
  }

  /**
   * Listen for alarm resolved events
   */
  @OnEvent('alarm.resolved')
  handleAlarmResolved(payload: { alarm: Alarm; userId: string }) {
    const { alarm } = payload;

    this.logger.log(`Broadcasting alarm resolved: ${alarm.id}`);

    this.server.to(`user:${alarm.userId}`).emit('alarm:resolved', {
      id: alarm.id,
      name: alarm.name,
      resolvedAt: alarm.resolvedAt,
      resolvedBy: alarm.resolvedBy,
      resolutionNote: alarm.resolutionNote,
    });

    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('alarm:resolved', {
        id: alarm.id,
        resolvedAt: alarm.resolvedAt,
      });
    }
  }

  /**
   * Manually emit alarm update to specific user
   */
  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
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
   * Check if user is connected
   */
  isUserConnected(userId: string): boolean {
    return (
      this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0
    );
  }
}
