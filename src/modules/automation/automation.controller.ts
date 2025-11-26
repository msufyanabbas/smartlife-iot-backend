import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AutomationService } from './automation.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('automation')
@Controller('automation')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new automation rule' })
  @ApiResponse({ status: 201, description: 'Automation created successfully' })
  @ApiResponse({ status: 409, description: 'Automation already exists' })
  create(
    @CurrentUser() user: User,
    @Body() createAutomationDto: CreateAutomationDto,
  ) {
    return this.automationService.create(user.id, createAutomationDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all automations with pagination' })
  @ApiResponse({ status: 200, description: 'List of automations' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.automationService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get automation statistics' })
  @ApiResponse({ status: 200, description: 'Automation statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.automationService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get automation by ID' })
  @ApiResponse({ status: 200, description: 'Automation details' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.automationService.findOne(id, user.id);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'Get automation execution logs' })
  @ApiResponse({ status: 200, description: 'Execution logs' })
  getExecutionLogs(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('limit') limit?: number,
  ) {
    return this.automationService.getExecutionLogs(id, user.id, limit);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update automation' })
  @ApiResponse({ status: 200, description: 'Automation updated successfully' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateAutomationDto: UpdateAutomationDto,
  ) {
    return this.automationService.update(id, user.id, updateAutomationDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete automation' })
  @ApiResponse({ status: 204, description: 'Automation deleted successfully' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.automationService.remove(id, user.id);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle automation status (enable/disable)' })
  @ApiResponse({ status: 200, description: 'Status toggled successfully' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  toggle(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.automationService.toggle(id, user.id);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Manually execute automation' })
  @ApiResponse({ status: 200, description: 'Automation executed successfully' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  @ApiResponse({ status: 409, description: 'Automation is disabled' })
  execute(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.automationService.execute(id, user.id);
  }
}
