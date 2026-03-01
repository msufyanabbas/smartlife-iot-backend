// src/modules/websocket/websocket.gateway.ts
import {
  WebSocketGateway,
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
import { WsJwtGuard } from '@common/guards/ws-jwt.guard';

interface AuthenticatedSocket extends Socket {
  data: {
    userId?: string;
    email?: string;
    role?: string;
    tenantId?: string;
    customerId?: string;
    user?: any;
  };
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || '*',
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
  
  // Track which clients are subscribed to which resources
  private subscriptions = new Map<string, Set<string>>();
  // socket.id → Set of room names (device:123, dashboard:456)
  
  constructor() {}

  afterInit(server: Server) {
    this.logger.log('🚀 WebSocket Gateway initialized');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONNECTION HANDLING
  // ══════════════════════════════════════════════════════════════════════════

  async handleConnection(client: AuthenticatedSocket) {
    try {
      this.logger.log(`✅ Client connected: ${client.id}`);

      // Initialize subscriptions for this client
      this.subscriptions.set(client.id, new Set());

      // Send welcome message
      client.emit('connected', {
        message: 'Connected to Smart Life IoT Platform',
        timestamp: new Date(),
      });

      // Broadcast connection count
      this.broadcastConnectionCount();
    } catch (error: any) {
      this.logger.error('Connection error:', error.message);
      client.emit('error', { message: 'Connection failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`❌ Client disconnected: ${client.id}`);

    // Clean up subscriptions
    this.subscriptions.delete(client.id);

    this.broadcastConnectionCount();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE SUBSCRIPTIONS (For Widgets)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to device telemetry updates
   * Called by widgets that display real-time device data
   */
  @SubscribeMessage('device:subscribe')
  @UseGuards(WsJwtGuard)
  handleDeviceSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    const room = `device:${data.deviceId}`;
    
    // Join the room
    client.join(room);
    
    // Track subscription
    const clientSubs = this.subscriptions.get(client.id);
    if (clientSubs) {
      clientSubs.add(room);
    }

    this.logger.log(`📡 Client ${client.id} subscribed to ${room}`);
    
    return { 
      success: true, 
      message: `Subscribed to device ${data.deviceId}`,
      room 
    };
  }

  /**
   * Unsubscribe from device updates
   */
  @SubscribeMessage('device:unsubscribe')
  @UseGuards(WsJwtGuard)
  handleDeviceUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    const room = `device:${data.deviceId}`;
    
    // Leave the room
    client.leave(room);
    
    // Remove from tracking
    const clientSubs = this.subscriptions.get(client.id);
    if (clientSubs) {
      clientSubs.delete(room);
    }

    this.logger.log(`📴 Client ${client.id} unsubscribed from ${room}`);
    
    return { 
      success: true, 
      message: `Unsubscribed from device ${data.deviceId}` 
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD SUBSCRIPTIONS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to dashboard updates
   * When user opens a dashboard, subscribe to all devices in that dashboard
   */
  @SubscribeMessage('dashboard:subscribe')
  @UseGuards(WsJwtGuard)
  handleDashboardSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { dashboardId: string; deviceIds: string[] },
  ) {
    const dashboardRoom = `dashboard:${data.dashboardId}`;
    client.join(dashboardRoom);

    // Subscribe to all devices in the dashboard
    data.deviceIds?.forEach(deviceId => {
      const deviceRoom = `device:${deviceId}`;
      client.join(deviceRoom);
      
      const clientSubs = this.subscriptions.get(client.id);
      if (clientSubs) {
        clientSubs.add(deviceRoom);
      }
    });

    this.logger.log(
      `📊 Client ${client.id} subscribed to dashboard ${data.dashboardId} ` +
      `with ${data.deviceIds?.length || 0} devices`
    );

    return { 
      success: true, 
      message: `Subscribed to dashboard ${data.dashboardId}`,
      subscribedDevices: data.deviceIds?.length || 0
    };
  }

  /**
   * Unsubscribe from dashboard
   */
  @SubscribeMessage('dashboard:unsubscribe')
  @UseGuards(WsJwtGuard)
  handleDashboardUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { dashboardId: string; deviceIds: string[] },
  ) {
    const dashboardRoom = `dashboard:${data.dashboardId}`;
    client.leave(dashboardRoom);

    // Unsubscribe from devices
    data.deviceIds?.forEach(deviceId => {
      const deviceRoom = `device:${deviceId}`;
      client.leave(deviceRoom);
      
      const clientSubs = this.subscriptions.get(client.id);
      if (clientSubs) {
        clientSubs.delete(deviceRoom);
      }
    });

    return { 
      success: true, 
      message: `Unsubscribed from dashboard ${data.dashboardId}` 
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WIDGET-SPECIFIC SUBSCRIPTIONS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to specific telemetry keys
   * Widget only cares about temperature, not humidity
   */
  @SubscribeMessage('widget:subscribe')
  @UseGuards(WsJwtGuard)
  handleWidgetSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      widgetId: string;
      deviceIds: string[];
      telemetryKeys?: string[];
    },
  ) {
    // Create a room for this specific widget
    const widgetRoom = `widget:${data.widgetId}`;
    client.join(widgetRoom);

    // Also subscribe to the devices
    data.deviceIds.forEach(deviceId => {
      const deviceRoom = `device:${deviceId}`;
      client.join(deviceRoom);
      
      const clientSubs = this.subscriptions.get(client.id);
      if (clientSubs) {
        clientSubs.add(deviceRoom);
      }
    });

    this.logger.log(
      `🎨 Widget ${data.widgetId} subscribed to ${data.deviceIds.length} devices` +
      (data.telemetryKeys ? ` (keys: ${data.telemetryKeys.join(', ')})` : '')
    );

    return { 
      success: true,
      widgetId: data.widgetId,
      subscribedDevices: data.deviceIds.length
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE COMMANDS (Control Widgets)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send command to device (e.g., from a switch widget)
   */
  @SubscribeMessage('device:command')
  @UseGuards(WsJwtGuard)
  handleDeviceCommand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { 
      deviceId: string; 
      command: string; 
      params?: any 
    },
  ) {
    this.logger.log(
      `🎛️ Device command from client ${client.id}: ` +
      `${data.command} on device ${data.deviceId}`
    );

    // Emit to MQTT service (which will forward to the actual device)
    this.server.emit('device:command:request', {
      userId: client.data.userId,
      tenantId: client.data.tenantId,
      deviceId: data.deviceId,
      command: data.command,
      params: data.params,
      timestamp: Date.now(),
    });

    return { 
      success: true, 
      message: 'Command sent to device' 
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BROADCAST METHODS (Called by Backend Services)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Broadcast device telemetry to all subscribed clients
   * Called by TelemetryConsumer when new data arrives
   */
  broadcastDeviceTelemetry(deviceId: string, telemetry: any) {
    const room = `device:${deviceId}`;
    
    this.server.to(room).emit('device:telemetry', {
      deviceId,
      timestamp: telemetry.timestamp,
      data: telemetry.data,
      // Include denormalized fields for convenience
      temperature: telemetry.temperature,
      humidity: telemetry.humidity,
      pressure: telemetry.pressure,
      batteryLevel: telemetry.batteryLevel,
    });

    this.logger.debug(`📤 Broadcast telemetry for device ${deviceId} to room ${room}`);
  }

  /**
   * Broadcast device status change
   */
  broadcastDeviceStatus(deviceId: string, status: any) {
    const room = `device:${deviceId}`;
    
    this.server.to(room).emit('device:status', {
      deviceId,
      status: status.status,
      isOnline: status.isOnline,
      lastSeenAt: status.lastSeenAt,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast alarm/alert
   */
  broadcastAlarm(alarm: any) {
    // Send to all clients in the tenant
    const tenantRoom = `tenant:${alarm.tenantId}`;
    
    this.server.to(tenantRoom).emit('alarm:new', {
      alarmId: alarm.id,
      deviceId: alarm.deviceId,
      severity: alarm.severity,
      type: alarm.type,
      message: alarm.message,
      timestamp: alarm.createdAt,
    });

    // Also send to device-specific room
    if (alarm.deviceId) {
      this.server.to(`device:${alarm.deviceId}`).emit('device:alarm', alarm);
    }
  }

  /**
   * Broadcast dashboard update
   * When dashboard is modified, notify all viewers
   */
  broadcastDashboardUpdate(dashboardId: string, update: any) {
    const room = `dashboard:${dashboardId}`;
    
    this.server.to(room).emit('dashboard:updated', {
      dashboardId,
      update,
      timestamp: Date.now(),
    });
  }

  /**
   * Send notification to specific user
   */
  sendToUser(userId: string, event: string, data: any) {
    const room = `user:${userId}`;
    this.server.to(room).emit(event, data);
  }

  /**
   * Broadcast to all clients
   */
  broadcast(event: string, data: any) {
    this.server.emit(event, data);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      connectedClients: this.subscriptions.size,
      totalSubscriptions: Array.from(this.subscriptions.values())
        .reduce((sum, subs) => sum + subs.size, 0),
    };
  }

  /**
   * Broadcast connection count
   */
  private broadcastConnectionCount() {
    const stats = this.getStats();
    this.server.emit('stats:connections', stats);
  }

  /**
   * Get subscriptions for a specific device
   */
  getDeviceSubscribers(deviceId: string): number {
    const room = `device:${deviceId}`;
    return this.server.sockets.adapter.rooms.get(room)?.size || 0;
  }
}