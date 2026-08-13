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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScriptsService } from './scripts.service';
import { CreateScriptDto } from './dto/create-script.dto';
import { UpdateScriptDto } from './dto/update-script.dto';
import { ExecuteScriptDto, TestScriptDto } from './dto/execute-script.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  SwaggerAuth,
  TenantOrCustomerAdmin,
} from '../../common/decorators/access-control.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('scripts')
@Controller('scripts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ScriptsController {
  constructor(private readonly scriptsService: ScriptsService) {}

  /**
   * Scripts are tenant-scoped, but `User.tenantId` is optional — SUPER_ADMIN
   * has no tenant. Rather than silently widening the query (which would leak
   * across tenants) or letting `undefined` reach the repository (which matches
   * nothing and reads as a confusing 404), say so explicitly.
   */
  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new ForbiddenException(
        'Scripts are tenant-scoped; this account has no tenant context',
      );
    }
    return user.tenantId;
  }

  @Post()
  @ApiOperation({ summary: 'Create a new script' })
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Body() createScriptDto: CreateScriptDto,
  ) {
    return this.scriptsService.create(userId, tenantId, createScriptDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all scripts' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.scriptsService.findAll(this.tenantOf(user), paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get script statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.scriptsService.getStatistics(this.tenantOf(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get script by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.scriptsService.findOne(id, this.tenantOf(user));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update script' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateScriptDto: UpdateScriptDto,
  ) {
    return this.scriptsService.update(
      id,
      this.tenantOf(user),
      user.id,
      updateScriptDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete script' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.scriptsService.remove(id, this.tenantOf(user));
  }

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Execute script', 'Run a script with provided input data')
  executeScript(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: ExecuteScriptDto,
  ) {
    return this.scriptsService.execute(id, this.tenantOf(user), body);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @TenantOrCustomerAdmin()
  @SwaggerAuth(
    'Test script',
    'Test a script with sample data and optional expected result',
  )
  testScript(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: TestScriptDto,
  ) {
    return this.scriptsService.test(id, this.tenantOf(user), body);
  }
}
