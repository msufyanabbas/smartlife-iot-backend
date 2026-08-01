// src/modules/device-commands/device-commands.controller.ts
import {
  Controller,
  Post,
  Get,
  Patch,
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
import { AcknowledgeCommandDto } from './dto/acknowledge-command.dto';
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
  // GET USER COMMAND HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Declared before @Get(':id'). Nest matches in declaration order, so while
  // this sat below ':id' the literal 'my-commands' was captured as an id and
  // rejected by ParseIdPipe with 400 — the route was unreachable.

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
  // ACKNOWLEDGE COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  @Patch(':id/acknowledge')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the terminal outcome of a command',
    description:
      'Marks the command COMPLETED, or FAILED when `error` is supplied. ' +
      'DELIVERED only means the command reached the broker — this is what ' +
      'reports whether the device actually executed it. JWT-protected: it is ' +
      'called by trusted backend components (rule engine, edge relay, ops UI). ' +
      'A device-facing variant would need device-token authentication rather ' +
      'than being left unauthenticated, since an open route here would let ' +
      'anyone mark any tenant\'s command delivered.',
  })
  @ApiResponse({ status: 200, description: 'Command acknowledged' })
  @ApiResponse({ status: 400, description: 'Command cancelled or already acknowledged' })
  @ApiResponse({ status: 404, description: 'Command not found' })
  async acknowledgeCommand(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) commandId: string,
    @Body() acknowledgeDto: AcknowledgeCommandDto,
  ) {
    const command = await this.commandsService.acknowledgeCommand(
      commandId,
      user.tenantId,
      acknowledgeDto,
    );

    return {
      success: true,
      message: 'Command acknowledged successfully',
      data: command,
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