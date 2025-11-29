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
import { SolutionTemplatesService } from './solution-template.service';
import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';
import { filter } from 'compression';

@ApiTags('solution-templates')
@Controller('solution-templates')
export class SolutionTemplatesController {
  constructor(
    private readonly solutionTemplatesService: SolutionTemplatesService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new solution template' })
  @ApiResponse({ status: 201, description: 'Template created successfully' })
  create(
    @CurrentUser() user: User,
    @Body() createDto: CreateSolutionTemplateDto,
  ) {
    return this.solutionTemplatesService.create(user.id, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all solution templates' })
  @ApiResponse({ status: 200, description: 'List of templates' })
  findAll(
   @Query() filters: FindAllTemplatesDto
  ) {
    return this.solutionTemplatesService.findAll(filters);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get all template categories' })
  @ApiResponse({ status: 200, description: 'List of categories' })
  getCategories() {
    return this.solutionTemplatesService.getCategories();
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get template statistics' })
  @ApiResponse({ status: 200, description: 'Template statistics' })
  getStatistics() {
    return this.solutionTemplatesService.getStatistics();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get template by ID' })
  @ApiResponse({ status: 200, description: 'Template details' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(@Param('id', ParseIdPipe) id: string) {
    return this.solutionTemplatesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update template' })
  @ApiResponse({ status: 200, description: 'Template updated successfully' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateSolutionTemplateDto,
  ) {
    return this.solutionTemplatesService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete template' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.solutionTemplatesService.remove(id, user.id);
  }

  @Post(':id/install')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Install solution template' })
  @ApiResponse({ status: 200, description: 'Template installed successfully' })
  install(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() installDto: InstallTemplateDto,
  ) {
    return this.solutionTemplatesService.install(id, user.id, installDto);
  }

  @Post(':id/rate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rate a template' })
  @ApiResponse({ status: 200, description: 'Template rated successfully' })
  rate(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: { rating: number },
  ) {
    return this.solutionTemplatesService.rateTemplate(id, user.id, body.rating);
  }
}
