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
import { User } from '@modules/users/entities/user.entity';
import { GatewayService } from './gateway.service';
import { DevicesService } from '@modules/devices/devices.service';

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

  @Get('status')
  @ApiOperation({ summary: 'Get MQTT gateway connection status' })
  getStatus() {
    return this.gatewayService.getStatus();
  }

  // ── Device control ────────────────────────────────────────────────────────
  // These endpoints were previously on DevicesController but live here to
  // avoid a circular dependency between DevicesModule and GatewayModule.

  @Post('devices/:deviceKey/command')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send command to device via MQTT' })
  @ApiResponse({ status: 200, description: 'Command sent successfully' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendCommand(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() command: DeviceCommandDto,
  ) {
    await this.devicesService.findByDeviceKey(deviceKey, user); // access check
    await this.gatewayService.sendCommand(deviceKey, command);
    return { success: true, message: 'Command sent to device', deviceKey, command: command.method };
  }

  @Post('devices/:deviceKey/rpc')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send RPC request to device' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendRpcRequest(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() body: { method: string; params?: Record<string, any> },
  ) {
    await this.devicesService.findByDeviceKey(deviceKey, user); // access check
    await this.gatewayService.sendRpcRequest(deviceKey, body.method, body.params);
    return { success: true, message: 'RPC request sent', deviceKey, method: body.method };
  }

  @Post('devices/:deviceKey/telemetry')
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