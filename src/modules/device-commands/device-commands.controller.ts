// src/modules/device-commands/device-commands.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DeviceCommandsService } from './device-commands.service';
import { CreateCommandDto } from './dto/create-command.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/index.entities';
import { TenantOrCustomerAdmin } from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';

@ApiTags('Device Commands')
@Controller('device-commands')
@ApiBearerAuth()
export class DeviceCommandsController {
  constructor(private readonly commandsService: DeviceCommandsService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Send command to device' })
  @ApiResponse({ status: 201, description: 'Command sent successfully' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async createCommand(
    @CurrentUser() user: User,
    @Body() createCommandDto: CreateCommandDto,
  ) {
    const command = await this.commandsService.createCommand(
      createCommandDto,
      user.id,
      user.tenantId,
    );

    return {
      success: true,
      message: 'Command sent successfully',
      data: command,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET COMMAND STATUS
  // ══════════════════════════════════════════════════════════════════════════

  @Get(':id')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Get command status' })
  @ApiResponse({ status: 200, description: 'Command status retrieved' })
  @ApiResponse({ status: 404, description: 'Command not found' })
  async getCommandStatus(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) commandId: string,
  ) {
    const command = await this.commandsService.getCommandStatus(
      commandId,
      user.tenantId,
    );

    return {
      success: true,
      data: command,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET DEVICE COMMAND HISTORY
  // ══════════════════════════════════════════════════════════════════════════

  @Get('device/:deviceId')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Get device command history' })
  @ApiResponse({ status: 200, description: 'Command history retrieved' })
  async getDeviceCommands(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('limit') limit: number = 50,
  ) {
    const commands = await this.commandsService.getDeviceCommands(
      deviceId,
      user.tenantId,
      limit,
    );

    return {
      success: true,
      data: commands,
      count: commands.length,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET USER COMMAND HISTORY
  // ══════════════════════════════════════════════════════════════════════════

  @Get('my-commands')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Get your command history' })
  @ApiResponse({ status: 200, description: 'Command history retrieved' })
  async getMyCommands(
    @CurrentUser() user: User,
    @Query('limit') limit: number = 100,
  ) {
    const commands = await this.commandsService.getUserCommands(
      user.id,
      user.tenantId,
      limit,
    );

    return {
      success: true,
      data: commands,
      count: commands.length,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANCEL COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  @Delete(':id')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel pending command' })
  @ApiResponse({ status: 200, description: 'Command cancelled' })
  @ApiResponse({ status: 400, description: 'Cannot cancel command in current status' })
  async cancelCommand(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) commandId: string,
  ) {
    const command = await this.commandsService.cancelCommand(
      commandId,
      user.tenantId,
    );

    return {
      success: true,
      message: 'Command cancelled successfully',
      data: command,
    };
  }
}