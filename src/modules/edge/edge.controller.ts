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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EdgeService } from './edge.service';
import { CreateEdgeInstanceDto } from './dto/create-edge-instance.dto';
import { UpdateEdgeInstanceDto } from './dto/update-edge-instance.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('edge')
@Controller('edge')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class EdgeController {
  constructor(private readonly edgeService: EdgeService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() createDto: CreateEdgeInstanceDto) {
    return this.edgeService.create(user.id, createDto);
  }

  @Get()
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.edgeService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  getStatistics(@CurrentUser() user: User) {
    return this.edgeService.getStatistics(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.findOne(id, user.id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateEdgeInstanceDto,
  ) {
    return this.edgeService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.remove(id, user.id);
  }
}
