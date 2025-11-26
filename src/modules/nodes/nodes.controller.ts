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
import { NodesService } from './nodes.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('nodes')
@Controller('nodes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new node' })
  @ApiResponse({ status: 201, description: 'Node created successfully' })
  create(@CurrentUser() user: User, @Body() createDto: CreateNodeDto) {
    return this.nodesService.create(user.id, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all nodes' })
  @ApiResponse({ status: 200, description: 'List of nodes' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.nodesService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get node statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.nodesService.getStatistics(user.id);
  }

  @Get('rule-chain/:ruleChainId')
  @ApiOperation({ summary: 'Get nodes by rule chain' })
  findByRuleChain(
    @CurrentUser() user: User,
    @Param('ruleChainId') ruleChainId: string,
  ) {
    return this.nodesService.findByRuleChain(user.id, ruleChainId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get node by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.nodesService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update node' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateNodeDto,
  ) {
    return this.nodesService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete node' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.nodesService.remove(id, user.id);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle node enabled status' })
  toggle(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.nodesService.toggle(id, user.id);
  }
}
