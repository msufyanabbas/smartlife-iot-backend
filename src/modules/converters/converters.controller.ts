import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';
import { User } from '../users/entities/user.entity';
import { ConvertersService } from './converters.service';
import { CreateConverterDto } from './dto/create-converter.dto';
import { UpdateConverterDto } from './dto/update-converter.dto';
import { QueryConvertersDto } from './dto/query-converters.dto';
import { TestConverterDto } from './dto/test-converter.dto';
import { RequirePermissions } from '@common/decorators/permission.decorator';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Data converters.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `RolesGuard` returns **true** when a handler carries no `@Roles` metadata, so
 * an undecorated route is open to every authenticated user, CUSTOMER_USER
 * included. That is how `IntegrationsController` ended up letting any user read
 * every integration's secrets (CLAUDE.md §4e). Every handler below therefore
 * carries an explicit `@Roles`, and `SUPER_ADMIN` is listed by name because the
 * guard has no bypass for it.
 *
 * A converter's `configuration` can hold a script, so the write surface and
 * `POST /:id/test` — which executes that script — are TENANT_ADMIN and above.
 * Reads stay open to CUSTOMER and CUSTOMER_USER so a dashboard can name the
 * converter a device's telemetry came through.
 *
 * Responses are the payload itself: `TransformInterceptor` already wraps every
 * response as `{success, data, timestamp}`, so a handler that also returned
 * `{message, data}` would put the payload at `.data.data`. `DELETE` is the one
 * exception and returns `{message}`, because the message IS the result.
 */
@ApiTags('converters')
@Controller('converters')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ConvertersController {
  constructor(private readonly convertersService: ConvertersService) {}

  // ── Catalogue ─────────────────────────────────────────────────────────────
  // Declared before `:id` so "catalogue" is not parsed as a converter id.

  @Get('catalogue')
  @RequirePermissions('integrations:list')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'The converter type catalogue',
    description:
      'One manifest per converter type: label, description, icon name, the ' +
      'directions it can run, and the configuration fields the create/edit ' +
      'form should render. The single source of truth for both the type picker ' +
      'and the generated form — a field added to a manifest appears in the UI ' +
      'with no frontend change, and the server validates exactly the keys it ' +
      'declares.\n\n' +
      'The `codec` type delegates to the device codec registry, so the 80+ ' +
      'Milesight codecs already in the platform are reachable from a converter.',
  })
  @ApiResponse({ status: 200, description: 'Converter type manifests' })
  getCatalogue() {
    return this.convertersService.getCatalogue();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermissions('integrations:list')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'List converters',
    description:
      'Paginated as `{data, meta:{page, limit, totalItems, totalPages}}`. ' +
      'Filterable by `direction`, `type` and `enabled`; searches name and ' +
      'description. Each row carries a derived `health` badge ' +
      '(ACTIVE/DISABLED/ERROR/PENDING) and `successRate`.',
  })
  @ApiResponse({ status: 200, description: 'Paginated converters' })
  findAll(@CurrentUser() user: User, @Query() query: QueryConvertersDto) {
    return this.convertersService.findAll(user, query);
  }

  @Get(':id')
  @RequirePermissions('integrations:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({ summary: 'Get one converter, with its derived health' })
  @ApiResponse({ status: 200, description: 'The converter' })
  @ApiResponse({ status: 404, description: 'Not found for this tenant' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.convertersService.findOneDecorated(id, user);
  }

  @Post()
  @RequirePermissions('integrations:create')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Create a converter',
    description:
      'The configuration is validated against its type\'s manifest and a ' +
      'script is compiled, so a 400 lists every problem at once in `errors[]` ' +
      'rather than one per save.',
  })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Configuration incomplete' })
  @ApiResponse({ status: 409, description: 'Name already used by this tenant' })
  create(@CurrentUser() user: User, @Body() dto: CreateConverterDto) {
    return this.convertersService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('integrations:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Update a converter',
    description:
      'The merged `{type, direction, configuration}` is re-validated, so ' +
      'switching the type without supplying a matching configuration is ' +
      'rejected rather than stored. A configuration edit also clears ' +
      '`lastError` — an operator correcting a converter is saying it is fixed.',
  })
  @ApiResponse({ status: 200, description: 'Updated' })
  update(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateConverterDto,
  ) {
    return this.convertersService.update(id, user, dto);
  }

  @Delete(':id')
  @RequirePermissions('integrations:delete')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Delete a converter (soft)',
    description:
      'Returns `{message}`, which here is the whole result — there is nothing ' +
      'else to say about a delete.',
  })
  @ApiResponse({ status: 200, description: 'Deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.convertersService.remove(id, user);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Post(':id/enable')
  @RequirePermissions('integrations:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable a converter',
    description: 'Also clears `lastError`: re-enabling asserts it is fixed.',
  })
  @ApiResponse({ status: 200, description: 'The updated converter' })
  enable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.convertersService.setEnabled(id, user, true);
  }

  @Post(':id/disable')
  @RequirePermissions('integrations:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable a converter',
    description:
      '`convert()` refuses a disabled converter with a 400 rather than passing ' +
      'the payload through untransformed.',
  })
  @ApiResponse({ status: 200, description: 'The updated converter' })
  disable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.convertersService.setEnabled(id, user, false);
  }

  // ── Test ──────────────────────────────────────────────────────────────────

  @Post(':id/test')
  @RequirePermissions('integrations:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a converter against a sample payload',
    description:
      'Returns `{success, output, deviceKey?, timestamp?, durationMs, trace[], ' +
      'logs?}`. The trace carries one entry per step — payload parse, identity ' +
      'and timestamp resolution, each mapping rule (with what the path resolved ' +
      'to and what was written), codec selection, decode — each with a status ' +
      'of ok/skipped/error and a one-line reason. A mapping that silently ' +
      'produced nothing is the failure this route exists to make visible.\n\n' +
      '`payload` may be an object or a hex/base64 string; a `codec` converter ' +
      'wants the latter. Downlink converters take `command: {type, params}`.\n\n' +
      'Execution counters are NOT touched (`statsRecorded: false` in the ' +
      'response): a few samples must not make a converter look unhealthier than ' +
      'its real traffic did. Unlike a rule-chain test this has no side effects ' +
      'at all — a converter transforms a value and writes nothing.',
  })
  @ApiResponse({ status: 200, description: 'Conversion result plus trace' })
  @ApiResponse({ status: 400, description: 'Missing payload or command' })
  test(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: TestConverterDto,
  ) {
    return this.convertersService.test(id, user, dto);
  }
}
