// src/modules/websocket/websocket.gateway.ts
import { websocketCorsOrigin } from '@common/utils/websocket-cors';
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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WsJwtGuard } from '@common/guards/ws-jwt.guard';
import { WsSubscriptionAuthorizer } from '@common/websocket/ws-subscription-authorizer';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';

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
    origin: websocketCorsOrigin(),
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
  // socket.id → Set of room names (device:123, dashboard:456)
  //
  // ── This map is PER-PROCESS, and that is fine except for one thing ────────
  // It is bookkeeping, not routing. What actually routes a message is the
  // Socket.IO room (`client.join`), and since main.ts attaches the Redis
  // adapter, room emits now cross every replica. The map only mirrors the
  // joins made by sockets connected to THIS process.
  //
  // So nothing here breaks at N replicas — but `getStats()` is a local figure,
  // not a cluster one. See the note on getStats().
  private subscriptions = new Map<string, Set<string>>();

  // Repositories are injected directly instead of DashboardsService /
  // TelemetryService: both DashboardsModule and TelemetryModule already import
  // WebsocketModule, so importing either back would be a module cycle. The
  // gateway only needs reads, which the repositories cover.
  constructor(
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    // WsJwtGuard proves WHO is connected. This proves WHAT they may watch —
    // every handler below used to join whatever room the client named.
    private readonly authorizer: WsSubscriptionAuthorizer,
  ) {}

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
  async handleDeviceSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { deviceId: string },
  ) {
    const deviceId = data?.deviceId;

    // The device must belong to the caller's tenant (and customer, if their
    // token is customer-scoped). Without this the uuid alone was the only
    // thing standing between an authenticated account and another tenant's
    // live telemetry.
    if (!(await this.authorizer.canSubscribeToDevice(client, deviceId))) {
      return {
        success: false,
        error: 'Device not found',
        message: `Not permitted to subscribe to device ${deviceId}`,
      };
    }

    const room = `device:${deviceId}`;

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
      message: `Subscribed to device ${deviceId}`,
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
  async handleDashboardSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { dashboardId: string; deviceIds: string[] },
  ) {
    // `deviceIds` arrives from the browser, so it is a request, not a fact.
    // Only the ids that survive tenant/customer scoping are joined; the rest
    // are reported back as refused rather than silently dropped, so a widget
    // pointing at a deleted or reassigned device is debuggable.
    const { allowed, refused } = await this.authorizer.authorizeDevices(
      client,
      data?.deviceIds,
    );

    const dashboardRoom = `dashboard:${data.dashboardId}`;
    client.join(dashboardRoom);

    // Subscribe to the devices the caller may actually see
    allowed.forEach(deviceId => {
      const deviceRoom = `device:${deviceId}`;
      client.join(deviceRoom);

      const clientSubs = this.subscriptions.get(client.id);
      if (clientSubs) {
        clientSubs.add(deviceRoom);
      }
    });

    this.logger.log(
      `📊 Client ${client.id} subscribed to dashboard ${data.dashboardId} ` +
      `with ${allowed.length} devices` +
      (refused.length > 0 ? ` (${refused.length} refused)` : '')
    );

    return {
      success: true,
      message: `Subscribed to dashboard ${data.dashboardId}`,
      subscribedDevices: allowed.length,
      refusedDevices: refused.length
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
  // DASHBOARD SUBSCRIPTION (server-resolved)
  //
  // Unlike 'dashboard:subscribe' above — which trusts a client-supplied
  // deviceIds list — this handler loads the dashboard itself, derives the
  // device set from its widgets, joins those rooms, and seeds the client with
  // the current values so widgets render populated instead of waiting for the
  // next telemetry message.
  // ══════════════════════════════════════════════════════════════════════════

  @SubscribeMessage('subscribe-dashboard')
  @UseGuards(WsJwtGuard)
  async handleDashboardSubscription(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { dashboardId: string },
  ) {
    const { dashboardId } = data ?? ({} as any);
    if (!dashboardId) {
      return { event: 'dashboard:error', data: { message: 'dashboardId is required' } };
    }

    // Tenant-scoped read — a socket cannot pull another tenant's dashboard.
    const dashboard = await this.dashboardRepository.findOne({
      where: { id: dashboardId, tenantId: client.data.tenantId },
    });

    if (!dashboard) {
      return {
        event: 'dashboard:error',
        data: { dashboardId, message: 'Dashboard not found' },
      };
    }

    await client.join(`dashboard:${dashboardId}`);
    const clientSubs = this.subscriptions.get(client.id);
    clientSubs?.add(`dashboard:${dashboardId}`);

    // getUsedDevices() understands both the legacy dataSource.deviceIds[] and
    // the current datasource.deviceId widget shapes.
    //
    // The dashboard read above is tenant-scoped, but that is not enough on its
    // own: widget configuration is arbitrary JSON written by tenant users, so
    // a widget can name any uuid it likes. Deriving the room list from the
    // dashboard moves the forgery one level down rather than preventing it, so
    // the derived ids are scoped too.
    const { allowed: deviceIds, refused } = await this.authorizer.authorizeDevices(
      client,
      dashboard.getUsedDevices(),
    );
    if (refused.length > 0) {
      this.logger.warn(
        `Dashboard ${dashboardId} references ${refused.length} device(s) ` +
          `outside the subscriber's scope; they were not joined`,
      );
    }

    for (const deviceId of deviceIds) {
      await client.join(`device:${deviceId}`);
      clientSubs?.add(`device:${deviceId}`);
    }

    // Seed the client with the latest reading per device. Queried directly so
    // one missing/unreadable device degrades to {} instead of failing the join.
    const currentData: Record<string, any> = {};
    for (const deviceId of deviceIds) {
      try {
        const latest = await this.telemetryRepository.findOne({
          where: { deviceId },
          order: { timestamp: 'DESC' },
        });
        currentData[deviceId] = latest
          ? { timestamp: latest.timestamp, data: latest.data ?? {} }
          : {};
      } catch (error: any) {
        this.logger.error(
          `Failed to load latest telemetry for device ${deviceId}: ${error.message}`,
        );
        currentData[deviceId] = {};
      }
    }

    client.emit('dashboard:current-data', {
      dashboardId,
      deviceCount: deviceIds.length,
      data: currentData,
    });

    this.logger.log(
      `📊 Client ${client.id} subscribed to dashboard ${dashboardId} ` +
        `(${deviceIds.length} devices resolved server-side)`,
    );

    return {
      event: 'dashboard:subscribed',
      data: { dashboardId, deviceCount: deviceIds.length },
    };
  }

  @SubscribeMessage('unsubscribe-dashboard')
  @UseGuards(WsJwtGuard)
  async handleDashboardUnsubscription(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { dashboardId: string },
  ) {
    const { dashboardId } = data ?? ({} as any);
    await client.leave(`dashboard:${dashboardId}`);
    this.subscriptions.get(client.id)?.delete(`dashboard:${dashboardId}`);

    // Device rooms are deliberately left joined: another dashboard or widget
    // on this socket may still need them. They are dropped on disconnect.
    return { event: 'dashboard:unsubscribed', data: { dashboardId } };
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
  async handleWidgetSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      widgetId: string;
      deviceIds: string[];
      telemetryKeys?: string[];
    },
  ) {
    // Same client-supplied list, same scoping. A widget was the easiest way
    // in: it accepts an arbitrary deviceIds array and `data.deviceIds.length`
    // was not even null-guarded.
    const { allowed, refused } = await this.authorizer.authorizeDevices(
      client,
      data?.deviceIds,
    );

    // Create a room for this specific widget
    const widgetRoom = `widget:${data.widgetId}`;
    client.join(widgetRoom);

    // Also subscribe to the devices the caller may see
    allowed.forEach(deviceId => {
      const deviceRoom = `device:${deviceId}`;
      client.join(deviceRoom);

      const clientSubs = this.subscriptions.get(client.id);
      if (clientSubs) {
        clientSubs.add(deviceRoom);
      }
    });

    this.logger.log(
      `🎨 Widget ${data.widgetId} subscribed to ${allowed.length} devices` +
      (refused.length > 0 ? ` (${refused.length} refused)` : '') +
      (data.telemetryKeys ? ` (keys: ${data.telemetryKeys.join(', ')})` : '')
    );

    return {
      success: true,
      widgetId: data.widgetId,
      subscribedDevices: allowed.length,
      refusedDevices: refused.length
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
  async handleDeviceCommand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: {
      deviceId: string;
      command: string;
      params?: any
    },
  ) {
    if (!(await this.authorizer.canSubscribeToDevice(client, data?.deviceId))) {
      return {
        success: false,
        error: 'Device not found',
        message: `Not permitted to command device ${data?.deviceId}`,
      };
    }

    this.logger.log(
      `🎛️ Device command from client ${client.id}: ` +
      `${data.command} on device ${data.deviceId}`
    );

    // This used to be `this.server.emit(...)`, which is a broadcast to every
    // socket connected to /ws — so one tenant's command, deviceId, userId and
    // tenantId were delivered to every other tenant's browser. Nothing on the
    // server ever listened for 'device:command:request', so the broadcast was
    // the only effect it had: the command reached no device.
    //
    // Narrowed to the device's own room, which only authorized subscribers
    // hold, and the sender is told plainly that this is not yet a delivery
    // path rather than being told "Command sent to device" when nothing was.
    this.server.to(`device:${data.deviceId}`).emit('device:command:request', {
      userId: client.data.userId,
      tenantId: client.data.tenantId,
      deviceId: data.deviceId,
      command: data.command,
      params: data.params,
      timestamp: Date.now(),
    });

    return {
      success: true,
      queued: false,
      message:
        'Command accepted for device ' +
        data.deviceId +
        '. Use the RPC endpoint for guaranteed delivery.',
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
   * Emit an arbitrary event into a device room.
   *
   * Unlike the broadcast* helpers below, this is null-safe: `server` is only
   * assigned once afterInit() has run, and background producers (the Tuya
   * poller's @Cron, in particular) can fire before the gateway is up. A push
   * that arrives too early is dropped rather than throwing into the caller.
   */
  emitToDevice(deviceId: string, event: string, payload: any): void {
    if (!this.server) return;
    this.server.to(`device:${deviceId}`).emit(event, payload);
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
   * Get connection statistics for THIS REPLICA.
   *
   * Deliberately not made cluster-wide. Both numbers come from the per-process
   * `subscriptions` map, so on three replicas each reports roughly a third of
   * the connections and `stats:connections` tells a given client a third of the
   * truth. Making it global would mean either a Redis counter that leaks on
   * every ungraceful exit, or `serverSideEmit` round trips on every connect and
   * disconnect — both worse than a correctly labelled local number.
   *
   * `node` is included so a consumer can tell the figures apart rather than
   * silently treating one replica's count as the platform's.
   */
  getStats() {
    return {
      node: `${process.env.HOSTNAME ?? 'node'}-${process.pid}`,
      scope: 'replica' as const,
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
  /**
   * How many sockets ON THIS REPLICA are in the device's room. The Redis
   * adapter replicates *emits*, not the local `rooms` map, so this is a local
   * count; `adapter.sockets(new Set([room]))` would be the cluster-wide
   * equivalent and is async.
   */
  getDeviceSubscribers(deviceId: string): number {
    const room = `device:${deviceId}`;
    return this.server.sockets.adapter.rooms.get(room)?.size || 0;
  }
}