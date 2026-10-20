import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AiService } from './ai.service';
import { AiInsightsService } from './ai-insights.service';
import { AI_PROVIDERS, type AiProvider } from './ai-provider.catalogue';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Public } from '@common/decorators/public.decorator';
import { TenantAdminOnly, TenantOrCustomerAdmin } from '@common/decorators/access-control.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { User } from '@modules/index.entities';

class UpsertAiModelDto {
  @IsString() @MaxLength(120) name: string;
  @IsIn(AI_PROVIDERS) provider: AiProvider;
  @IsString() @MaxLength(200) modelId: string;

  @IsOptional() @IsString() description?: string;
  /** Write-only. The stored key is never returned. */
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
  @IsOptional() @IsObject() providerOptions?: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(0) @Max(2) temperature?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) topP?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(200000) maxOutputTokens?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class DeviceInsightDto {
  @IsOptional() @IsString() modelId?: string;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) context?: string;
}

/**
 * AI model registry and AI-assisted analysis.
 *
 * Writes are TENANT_ADMIN and above: a model row holds a billable provider
 * credential, and `IntegrationsController` is the cautionary tale — it had no
 * @Roles at all, so any authenticated user could read every cloud credential
 * in the tenant (§4g).
 */
@ApiTags('AI')
@Controller('ai')
@ApiBearerAuth()
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly insights: AiInsightsService,
  ) {}

  /**
   * An AI model row is tenant-scoped, and SUPER_ADMIN legitimately has no
   * tenant. Rather than widen every signature to `string | undefined` and let
   * a falsy tenant produce an unscoped query (§4g), the tenant-less caller is
   * refused here with an explanation.
   */
  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'AI models belong to a tenant. Sign in as a tenant administrator, or ' +
          'select a tenant first.',
      );
    }
    return user.tenantId;
  }

  @Get('catalogue')
  @Public()
  @ApiOperation({
    summary: 'Supported providers and their credential fields',
    description:
      'Public because it contains no tenant data — it is the manifest the ' +
      'settings form is generated from.',
  })
  getCatalogue() {
    return this.ai.getCatalogue();
  }

  @Get('models')
  @RequirePermissions('settings:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Registered AI models for this tenant' })
  findAll(@CurrentUser() user: User) {
    return this.ai.findAll(this.tenantOf(user));
  }

  @Get('models/:id')
  @RequirePermissions('settings:read')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'One AI model (never includes the API key)' })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.findOne(id, this.tenantOf(user));
  }

  @Post('models')
  @RequirePermissions('settings:create')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Register an AI model' })
  @ApiResponse({ status: 201, description: 'Created' })
  create(@CurrentUser() user: User, @Body() dto: UpsertAiModelDto) {
    return this.ai.create(this.tenantOf(user), dto);
  }

  @Patch('models/:id')
  @RequirePermissions('settings:update')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Update an AI model',
    description:
      'Omit apiKey to leave the stored credential untouched — the screen ' +
      'never receives it, so it cannot send it back.',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<UpsertAiModelDto>,
  ) {
    return this.ai.update(id, this.tenantOf(user), dto as any);
  }

  @Delete('models/:id')
  @RequirePermissions('settings:delete')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an AI model' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.ai.remove(id, this.tenantOf(user));
    return { success: true };
  }

  @Post('models/:id/check')
  @RequirePermissions('settings:update')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a real request to verify the credential',
    description:
      'Costs a few tokens at the provider. Cheaper than finding out from a ' +
      'rule chain at 3am.',
  })
  check(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.checkConnectivity(id, this.tenantOf(user));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INSIGHTS
  // ══════════════════════════════════════════════════════════════════════════

  @Post('insights/device/:deviceId')
  @TenantOrCustomerAdmin()
  @RequirePermissions('devices:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI analysis of a device’s telemetry',
    description:
      'Statistics are computed server-side and the model interprets them. ' +
      'It does NOT forecast — see AiInsightsService for why that is ' +
      'deliberate.',
  })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  analyseDevice(
    @CurrentUser() user: User,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() dto: DeviceInsightDto,
  ) {
    return this.insights.analyseDevice({
      deviceId,
      userId: user.id,
      tenantId: this.tenantOf(user),
      modelId: dto.modelId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      context: dto.context,
    });
  }
}
