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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScriptsService } from './scripts.service';
import { CreateScriptDto } from './dto/create-script.dto';
import { UpdateScriptDto } from './dto/update-script.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('scripts')
@Controller('scripts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ScriptsController {
  constructor(private readonly scriptsService: ScriptsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new script' })
  create(@CurrentUser() user: User, @Body() createScriptDto: CreateScriptDto) {
    return this.scriptsService.create(user.id, createScriptDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all scripts' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.scriptsService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get script statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.scriptsService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get script by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.scriptsService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update script' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateScriptDto: UpdateScriptDto,
  ) {
    return this.scriptsService.update(id, user.id, updateScriptDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete script' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.scriptsService.remove(id, user.id);
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test script execution' })
  test(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() testData: any,
  ) {
    return this.scriptsService.test(id, user.id, testData);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Execute script' })
  execute(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() inputData: any,
  ) {
    return this.scriptsService.execute(id, user.id, inputData);
  }
}
