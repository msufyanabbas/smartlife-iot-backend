import {
  WebSocketGateway as NestWebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

@NestWebSocketGateway({
  cors: {
    // origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    origin: '*',
    credentials: true,
  },
  namespace: '/ws',
})
export class WebsocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private connectedClients = new Map<string, AuthenticatedSocket>();
  private userSockets = new Map<string, Set<string>>(); // userId -> Set of socket IDs

  constructor(private jwtService: JwtService) {}

  afterInit(server: Server) {
    this.logger.log('🚀 WebSocket Gateway initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      this.logger.log(`✅ Client connected: ${client.id}`);
      // // Extract token from handshake
      // const token = client.handshake.auth.token ||
      //              client.handshake.headers.authorization?.replace('Bearer ', '');

      // if (!token) {
      //   this.logger.warn('Client connection rejected: No token provided');
      //   client.disconnect();
      //   return;
      // }

      // // Verify JWT token
      // const payload = await this.jwtService.verifyAsync(token);
      // client.userId = payload.sub;
      // client.userEmail = payload.email;

      // Store connection
      this.connectedClients.set(client.id, client);

      // Map user to socket
      if (client.userId) {
        if (!this.userSockets.has(client.userId)) {
          this.userSockets.set(client.userId, new Set());
        }
        this.userSockets.get(client.userId)!.add(client.id);

        // Join user-specific room
        client.join(`user:${client.userId}`);
      }

      this.logger.log(
        `✅ Client connected: ${client.id} (User: ${client.userEmail})`,
      );

      // Send welcome message
      client.emit('connected', {
        message: 'Connected to IoT Platform WebSocket',
        userId: client.userId,
        timestamp: new Date(),
      });

      // Emit connection count
      this.broadcastConnectionCount();
    } catch (error) {
      this.logger.error('Authentication failed:', error.message);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Remove from connected clients
    this.connectedClients.delete(client.id);

    // Remove from user sockets mapping
    if (client.userId && this.userSockets.has(client.userId)) {
      this.userSockets.get(client.userId)!.delete(client.id);
      if (this.userSockets.get(client.userId)!.size === 0) {
        this.userSockets.delete(client.userId);
      }
    }

    this.broadcastConnectionCount();
  }

  /**
   * Subscribe to device updates
   */
  @SubscribeMessage('device:subscribe')
  handleDeviceSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    const room = `device:${data.deviceId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} subscribed to ${room}`);
    return { success: true, message: `Subscribed to device ${data.deviceId}` };
  }

  /**
   * Unsubscribe from device updates
   */
  @SubscribeMessage('device:unsubscribe')
  handleDeviceUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    const room = `device:${data.deviceId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} unsubscribed from ${room}`);
    return {
      success: true,
      message: `Unsubscribed from device ${data.deviceId}`,
    };
  }

  /**
   * Send command to device (via MQTT)
   */
  @SubscribeMessage('device:command')
  handleDeviceCommand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string; command: string; params?: any },
  ) {
    this.logger.log(`Device command from ${client.userEmail}: ${data.command}`);

    // This will be handled by the gateway service
    this.server.emit('device:command:request', {
      userId: client.userId,
      deviceId: data.deviceId,
      command: data.command,
      params: data.params,
    });

    return { success: true, message: 'Command sent' };
  }

  /**
   * Request device status
   */
  @SubscribeMessage('device:status')
  handleDeviceStatus(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    // Emit request for status
    this.server.emit('device:status:request', {
      userId: client.userId,
      deviceId: data.deviceId,
    });
    return { success: true };
  }

  /**
   * Broadcast device telemetry to subscribed clients
   */
  broadcastDeviceTelemetry(deviceId: string, data: any) {
    const room = `device:${deviceId}`;
    this.server.to(room).emit('device:telemetry', data);
  }

  /**
   * Broadcast device status
   */
  broadcastDeviceStatus(deviceId: string, data: any) {
    const room = `device:${deviceId}`;
    this.server.to(room).emit('device:status', data);
  }

  /**
   * Broadcast alert
   */
  broadcastAlert(alert: any) {
    this.server.emit('device:alert', alert);
  }

  /**
   * Send message to specific user
   */
  sendToUser(userId: string, event: string, data: any) {
    const room = `user:${userId}`;
    this.server.to(room).emit(event, data);
  }

  /**
   * Broadcast to all connected clients
   */
  broadcast(event: string, data: any) {
    this.server.emit(event, data);
  }

  /**
   * Broadcast connection count
   */
  private broadcastConnectionCount() {
    this.server.emit('clients:count', {
      count: this.connectedClients.size,
      users: this.userSockets.size,
    });
  }

  /**
   * Get connected clients count
   */
  getConnectedCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Get user connections
   */
  getUserConnections(userId: string): number {
    return this.userSockets.get(userId)?.size || 0;
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}
