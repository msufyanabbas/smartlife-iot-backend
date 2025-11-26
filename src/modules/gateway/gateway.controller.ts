import {
  Controller,
  Post,
  Body,
  Get,
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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GatewayService } from './gateway.service';
import type { DeviceCommand } from './gateway.service';

@ApiTags('Gateway')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('gateway')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get gateway connection status' })
  @ApiResponse({ status: 200, description: 'Gateway status retrieved' })
  getStatus() {
    return this.gatewayService.getStatus();
  }

  @Post('devices/:deviceKey/command')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send command to device' })
  @ApiResponse({ status: 200, description: 'Command sent successfully' })
  @ApiResponse({ status: 400, description: 'Invalid command' })
  async sendCommand(
    @Param('deviceKey') deviceKey: string,
    @Body() command: DeviceCommand,
  ) {
    await this.gatewayService.sendCommand(deviceKey, command);
    return {
      success: true,
      message: 'Command sent to device',
      deviceKey,
      command: command.method,
    };
  }

  @Post('devices/:deviceKey/rpc')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send RPC request to device' })
  @ApiResponse({ status: 200, description: 'RPC request sent' })
  async sendRpcRequest(
    @Param('deviceKey') deviceKey: string,
    @Body() body: { method: string; params?: Record<string, any> },
  ) {
    await this.gatewayService.sendRpcRequest(
      deviceKey,
      body.method,
      body.params,
    );
    return {
      success: true,
      message: 'RPC request sent',
      deviceKey,
      method: body.method,
    };
  }

  @Post('devices/:deviceKey/attributes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update device attributes' })
  @ApiResponse({ status: 200, description: 'Attributes updated' })
  async updateAttributes(
    @Param('deviceKey') deviceKey: string,
    @Body() attributes: Record<string, any>,
  ) {
    await this.gatewayService.updateDeviceAttributes(deviceKey, attributes);
    return {
      success: true,
      message: 'Attributes updated',
      deviceKey,
    };
  }

  @Post('devices/:deviceKey/telemetry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish telemetry (for testing)' })
  @ApiResponse({ status: 200, description: 'Telemetry published' })
  async publishTelemetry(
    @Param('deviceKey') deviceKey: string,
    @Body() telemetry: Record<string, any>,
  ) {
    await this.gatewayService.publishTelemetry(deviceKey, telemetry);
    return {
      success: true,
      message: 'Telemetry published',
      deviceKey,
    };
  }
}
