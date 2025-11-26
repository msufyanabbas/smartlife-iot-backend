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

/**
 * WebSocket Gateway for real-time telemetry streaming
 * Broadcasts telemetry data to connected clients
 */
@WebSocketGateway({
  namespace: 'telemetry',
  cors: {
    origin: '*', // Configure properly in production
  },
})
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TelemetryGateway.name);
  private deviceSubscriptions: Map<string, Set<string>> = new Map(); // deviceId -> socketIds
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> socketIds

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to telemetry: ${client.id}`);

    const userId = client.handshake.auth?.userId;
    if (userId) {
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);
      client.join(`user:${userId}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from telemetry: ${client.id}`);

    // Remove from user sockets
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

    // Remove from device subscriptions
    this.deviceSubscriptions.forEach((sockets, deviceId) => {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.deviceSubscriptions.delete(deviceId);
      }
    });
  }

  /**
   * Subscribe to device telemetry
   */
  @SubscribeMessage('subscribe')
  @UseGuards(WsJwtGuard)
  handleSubscribe(client: Socket, deviceId: string) {
    if (!this.deviceSubscriptions.has(deviceId)) {
      this.deviceSubscriptions.set(deviceId, new Set());
    }
    this.deviceSubscriptions.get(deviceId)!.add(client.id);

    client.join(`device:${deviceId}`);
    this.logger.log(`Client ${client.id} subscribed to device ${deviceId}`);

    return { event: 'subscribed', data: { deviceId } };
  }

  /**
   * Unsubscribe from device telemetry
   */
  @SubscribeMessage('unsubscribe')
  @UseGuards(WsJwtGuard)
  handleUnsubscribe(client: Socket, deviceId: string) {
    const sockets = this.deviceSubscriptions.get(deviceId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.deviceSubscriptions.delete(deviceId);
      }
    }

    client.leave(`device:${deviceId}`);
    this.logger.log(`Client ${client.id} unsubscribed from device ${deviceId}`);

    return { event: 'unsubscribed', data: { deviceId } };
  }

  /**
   * Get current subscriptions for a client
   */
  @SubscribeMessage('get:subscriptions')
  handleGetSubscriptions(client: Socket) {
    const subscriptions: string[] = [];

    this.deviceSubscriptions.forEach((sockets, deviceId) => {
      if (sockets.has(client.id)) {
        subscriptions.push(deviceId);
      }
    });

    return { event: 'subscriptions', data: subscriptions };
  }

  /**
   * Listen for telemetry received events
   */
  @OnEvent('telemetry.received')
  handleTelemetryReceived(payload: {
    deviceId: string;
    data: Record<string, any>;
    timestamp: Date;
  }) {
    const { deviceId, data, timestamp } = payload;

    // Broadcast to device-specific room
    this.server.to(`device:${deviceId}`).emit('telemetry:data', {
      deviceId,
      data,
      timestamp,
    });

    // Log subscribers count
    const subscribersCount = this.deviceSubscriptions.get(deviceId)?.size || 0;
    if (subscribersCount > 0) {
      this.logger.debug(
        `Broadcasted telemetry for device ${deviceId} to ${subscribersCount} subscribers`,
      );
    }
  }

  /**
   * Listen for batch telemetry events
   */
  @OnEvent('telemetry.batch')
  handleTelemetryBatch(payload: {
    deviceId: string;
    batch: Array<{ data: Record<string, any>; timestamp: Date }>;
  }) {
    const { deviceId, batch } = payload;

    this.server.to(`device:${deviceId}`).emit('telemetry:batch', {
      deviceId,
      batch,
    });
  }

  /**
   * Listen for device status change events
   */
  @OnEvent('device.status.changed')
  handleDeviceStatusChanged(payload: {
    deviceId: string;
    status: string;
    previousStatus: string;
  }) {
    const { deviceId, status, previousStatus } = payload;

    this.server.to(`device:${deviceId}`).emit('device:status', {
      deviceId,
      status,
      previousStatus,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast telemetry to specific device subscribers
   */
  broadcastToDevice(deviceId: string, event: string, data: any) {
    this.server.to(`device:${deviceId}`).emit(event, data);
  }

  /**
   * Broadcast to specific user
   */
  broadcastToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Broadcast to all connected clients
   */
  broadcastToAll(event: string, data: any) {
    this.server.emit(event, data);
  }

  /**
   * Get number of subscribers for a device
   */
  getSubscribersCount(deviceId: string): number {
    return this.deviceSubscriptions.get(deviceId)?.size || 0;
  }

  /**
   * Get all active device subscriptions
   */
  getActiveDevices(): string[] {
    return Array.from(this.deviceSubscriptions.keys());
  }

  /**
   * Get connected users count
   */
  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  /**
   * Check if device has subscribers
   */
  hasSubscribers(deviceId: string): boolean {
    return (
      this.deviceSubscriptions.has(deviceId) &&
      this.deviceSubscriptions.get(deviceId)!.size > 0
    );
  }
}
