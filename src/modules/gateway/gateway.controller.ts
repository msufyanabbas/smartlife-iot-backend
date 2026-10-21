import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { TenantOrCustomerAdmin } from '@common/decorators/access-control.decorator';
import { User } from '@modules/users/entities/user.entity';
import { GatewayService } from './gateway.service';
import { DevicesService } from '@modules/devices/devices.service';
import { SendRpcDto } from './dto/send-rpc.dto';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

export interface DeviceCommandDto {
  method: string;
  params?: Record<string, any>;
}

@ApiTags('Gateway')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('gateway')
export class GatewayController {
  constructor(
    private readonly gatewayService: GatewayService,
    private readonly devicesService: DevicesService,
  ) {}

  // ── NOTE on the decorators below ──────────────────────────────────────────
  // RolesGuard returns TRUE for a handler that carries no @Roles metadata, so
  // every route in this file was reachable by any authenticated user —
  // including CUSTOMER_USER — and all four of them actuate devices. They now
  // carry @TenantOrCustomerAdmin() explicitly.

  @Get('status')
  @RequirePermissions('devices:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Get MQTT gateway connection status',
    description:
      'Includes `rpcResponseListenerConnected` and `rpcPendingRequests`. If ' +
      'the former is false, two-way RPC cannot complete and every call will ' +
      'time out — that is a gateway problem, not a device problem.',
  })
  getStatus() {
    return this.gatewayService.getStatus();
  }

  // ── Device control ────────────────────────────────────────────────────────
  // These endpoints were previously on DevicesController but live here to
  // avoid a circular dependency between DevicesModule and GatewayModule.

  @Post('devices/:deviceKey/command')
  @RequirePermissions('devices:control')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send command to device via MQTT (one-way)',
    description:
      'Fire-and-forget: the command is encoded and published, and success ' +
      'means the broker accepted it. Nothing here waits for the device. Use ' +
      'POST /gateway/devices/:deviceKey/rpc when you need to know what the ' +
      'device actually did.',
  })
  @ApiResponse({ status: 200, description: 'Command published to the broker' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendCommand(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() command: DeviceCommandDto,
  ) {
    await this.devicesService.findByDeviceKey(deviceKey, user); // access check
    // The actor is passed through so the `device.command.sent` audit row names
    // who sent it. No @Audit() on this route: that would be a second row for
    // the same action, and the event's is the better one — it also covers the
    // queued dispatch path, which never reaches a controller.
    await this.gatewayService.sendCommand(deviceKey, command, user);
    return { success: true, message: 'Command sent to device', deviceKey, command: command.method };
  }

  @Post('devices/:deviceKey/rpc')
  @Audit({
    action: AuditAction.DEVICE_COMMAND,
    entityType: AuditEntityType.DEVICE,
    description: 'device command device control',
  })
  @RequirePermissions('devices:control')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a two-way RPC request to a device and wait for its answer',
    description:
      'The request is published to `devices/{deviceKey}/rpc/request` with a ' +
      'UUID correlation id, and this call BLOCKS until the device publishes ' +
      'to `devices/{deviceKey}/rpc/response` with the same id, or until ' +
      '`timeoutMs` elapses (default 30000, clamped 1000–300000).\n\n' +
      'The response body reports what happened:\n' +
      '  status=response  — the device answered; `response` is its payload ' +
      '(and `error` is set when the device itself reported one)\n' +
      '  status=timeout   — the device never answered within the timeout\n' +
      '  status=cancelled — the broker connection dropped before an answer\n' +
      '  status=sent      — `waitForResponse: false` was passed\n\n' +
      'HTTP 200 means "the RPC was carried out and here is the outcome", NOT ' +
      '"the device succeeded" — read `status`. A 5xx is reserved for the ' +
      'publish itself failing.\n\n' +
      'Every call also opens a `device_commands` history row and returns its ' +
      '`commandId`, so the terminal outcome is auditable afterwards via ' +
      'GET /device-commands/{commandId}. Pass `waitForResponse: false` to ' +
      'return immediately and poll that row instead of holding the connection.',
  })
  @ApiResponse({
    status: 200,
    description:
      'RPC completed — inspect `status` for the device-side outcome',
  })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendRpcRequest(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() body: SendRpcDto,
  ) {
    await this.devicesService.findByDeviceKey(deviceKey, user); // access check

    // TransformInterceptor wraps this as { success, data, timestamp }, so the
    // outcome is returned directly rather than nested under another `data`.
    return this.gatewayService.sendRpcRequest(deviceKey, body.method, body.params, {
      timeoutMs: body.timeoutMs,
      waitForResponse: body.waitForResponse,
      // tenantId comes from the caller's JWT, never from the body.
      userId: user.id,
      tenantId: user.tenantId,
    });
  }

  @Post('devices/:deviceKey/telemetry')
  @RequirePermissions('devices:update')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish test telemetry (for testing/debugging)' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async publishTelemetry(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() telemetry: Record<string, any>,
  ) {
    await this.devicesService.findByDeviceKey(deviceKey, user); // access check
    await this.gatewayService.publishTelemetry(deviceKey, telemetry);
    return { success: true, message: 'Telemetry published', deviceKey };
  }
}
