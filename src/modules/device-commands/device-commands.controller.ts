// src/modules/device-commands/device-commands.controller.ts

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Request,
  Query,
  Delete,
} from '@nestjs/common';
import { DeviceCommandsService } from './device-commands.service';
import { CreateCommandDto } from './dto/create-command.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';

@Controller('api/v1/device-commands')
@UseGuards(JwtAuthGuard)
export class DeviceCommandsController {
  constructor(private readonly commandsService: DeviceCommandsService) {}

  /**
   * Send command to device
   * POST /api/v1/device-commands
   *
   * Example:
   * {
   *   "deviceId": "uuid",
   *   "commandType": "turnOn",
   *   "params": { "brightness": 80 },
   *   "priority": "NORMAL"
   * }
   */
  @Post()
  async createCommand(
    @Body() createCommandDto: CreateCommandDto,
    @Request() req,
  ) {
    const command = await this.commandsService.createCommand(
      createCommandDto,
      req.user.id,
      req.user.tenantId,
    );

    return {
      success: true,
      data: command,
      message: 'Command sent successfully',
    };
  }

  /**
   * Get command status
   * GET /api/v1/device-commands/:id
   */
  @Get(':id')
  async getCommandStatus(@Param('id') commandId: string, @Request() req) {
    const command = await this.commandsService.getCommandStatus(
      commandId,
      req.user.tenantId,
    );

    return {
      success: true,
      data: command,
    };
  }

  /**
   * Get device command history
   * GET /api/v1/device-commands/device/:deviceId?limit=50
   */
  @Get('device/:deviceId')
  async getDeviceCommands(
    @Param('deviceId') deviceId: string,
    @Query('limit') limit: number = 50,
    @Request() req,
  ) {
    const commands = await this.commandsService.getDeviceCommands(
      deviceId,
      req.user.tenantId,
      limit,
    );

    return {
      success: true,
      data: commands,
      count: commands.length,
    };
  }

  /**
   * Get user's command history
   * GET /api/v1/device-commands/my-commands?limit=100
   */
  @Get('my-commands')
  async getMyCommands(@Query('limit') limit: number = 100, @Request() req) {
    const commands = await this.commandsService.getUserCommands(
      req.user.id,
      req.user.tenantId,
      limit,
    );

    return {
      success: true,
      data: commands,
      count: commands.length,
    };
  }

  /**
   * Cancel pending command
   * DELETE /api/v1/device-commands/:id
   */
  @Delete(':id')
  async cancelCommand(@Param('id') commandId: string, @Request() req) {
    const command = await this.commandsService.cancelCommand(
      commandId,
      req.user.tenantId,
    );

    return {
      success: true,
      data: command,
      message: 'Command cancelled',
    };
  }
}
