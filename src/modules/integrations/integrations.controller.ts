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
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/enums/index.enum';
import { IntegrationsService } from './integrations.service';
import { LorawanService } from './lorawan.service';
import { IntegrationUplinkService } from './integration-uplink.service';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { IntegrationActivityDto } from './dto/integration-activity.dto';
import { TuyaCommandDto } from './dto/tuya-command.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

/**
 * RolesGuard is listed explicitly because it returns TRUE when a handler has no
 * @Roles metadata. Before this, the controller had neither, so every
 * authenticated user — including a CUSTOMER_USER — could create an integration
 * carrying a tenant's cloud credentials and read every integration's
 * configuration, secrets included.
 *
 * Integrations are tenant infrastructure, so the write surface is TENANT_ADMIN
 * and above. CUSTOMER may read, because the dashboard tiles call the statistics
 * and activity routes.
 */
@ApiTags('integrations')
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly lorawanService: LorawanService,
    private readonly uplinkService: IntegrationUplinkService,
  ) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create a new integration' })
  @ApiResponse({ status: 201, description: 'Integration created successfully' })
  @ApiResponse({ status: 409, description: 'Integration already exists' })
  create(
    @CurrentUser() user: User,
    @Body() createIntegrationDto: CreateIntegrationDto,
  ) {
    return this.integrationsService.create(user, createIntegrationDto);
  }

  @Get()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({ summary: 'Get all integrations with pagination' })
  @ApiResponse({ status: 200, description: 'List of integrations' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.integrationsService.findAll(user, paginationDto);
  }

  @Get('catalogue')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'The integration type catalogue',
    description:
      'Every supported integration type with its label, category, direction, ' +
      'icon name, and the configuration fields the create/edit form should ' +
      'render. The single source of truth for both the type gallery and the ' +
      'form — a type added here appears in the UI with no frontend change.\n\n' +
      '`hasAdapter: false` means telemetry is not forwarded for that type yet; ' +
      '`adapterNote` says what to use instead. `inboundPath`, where present, is ' +
      'the URL an external source should push to.',
  })
  @ApiResponse({ status: 200, description: 'Integration type manifests' })
  getCatalogue() {
    return this.integrationsService.getCatalogue();
  }

  @Get('events')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Tenant-wide integration event feed',
    description:
      'A real append-only feed, unlike /recent-activity which synthesises one ' +
      "entry per integration from its current column values. Each row records " +
      'one dispatch, uplink, probe or lifecycle change.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Max 100 (default 25)' })
  @ApiQuery({
    name: 'direction',
    required: false,
    description: 'inbound | outbound | lifecycle',
  })
  @ApiQuery({ name: 'success', required: false, description: 'true | false' })
  @ApiResponse({ status: 200, description: 'Paginated event feed' })
  getTenantEvents(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('direction') direction?: string,
    @Query('success') success?: string,
  ) {
    return this.integrationsService.getTenantEvents(user, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      direction,
      success: success === undefined ? undefined : success === 'true',
    });
  }

  @Get('inbound-status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Live inbound MQTT subscriptions',
    description:
      'Which MQTT integrations currently hold a connection to their broker, ' +
      'and on which topic. Diagnostics: an integration configured to subscribe ' +
      'but missing from this list has a broker it cannot reach.',
  })
  @ApiResponse({ status: 200, description: 'Live subscriptions' })
  getInboundStatus(@CurrentUser() user: User) {
    return this.integrationsService.getInboundStatus(user);
  }

  @Get('statistics')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({ summary: 'Get integration statistics' })
  @ApiResponse({ status: 200, description: 'Integration statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.integrationsService.getStatistics(user);
  }

  @Get('recent-activity')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'Get recent integration activity',
    description:
      'Recent activity feed derived from integration state (no dedicated event log exists). ' +
      "Entries are ordered by each integration's most recent relevant timestamp.",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max entries (default 10, max 50)',
    example: 10,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, 1-based (default 1)',
    example: 1,
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description:
      'Filter by integration type (cloud | webhook | mqtt | notification | api | database)',
  })
  @ApiResponse({
    status: 200,
    description: 'Recent integration activity (paginated).',
    type: IntegrationActivityDto,
    isArray: true,
  })
  getRecentActivity(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('type') type?: string,
  ) {
    return this.integrationsService.getRecentActivity(user, {
      limit,
      page,
      type,
    });
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get integration by ID',
    description:
      'TENANT_ADMIN and above only — the response includes `configuration`, ' +
      'which holds the integration secrets (broker passwords, cloud keys).',
  })
  @ApiResponse({ status: 200, description: 'Integration details' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.integrationsService.findOne(id, user);
  }

  @Get(':id/events')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Event feed for one integration',
    description:
      'Every dispatch, uplink, probe and lifecycle change, newest first, with ' +
      'a trimmed copy of the payload.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Max 100 (default 25)' })
  @ApiQuery({ name: 'direction', required: false, description: 'inbound | outbound | lifecycle' })
  @ApiQuery({ name: 'success', required: false, description: 'true | false' })
  @ApiResponse({ status: 200, description: 'Paginated event feed' })
  getEvents(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('direction') direction?: string,
    @Query('success') success?: string,
  ) {
    return this.integrationsService.getEvents(id, user, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      direction,
      success: success === undefined ? undefined : success === 'true',
    });
  }

  @Get(':id/summary')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Success/failure counts over a window',
    description:
      'Inbound and outbound, succeeded and failed, counted from the event feed ' +
      'over the last `hours` (default 24, max 168).',
  })
  @ApiQuery({ name: 'hours', required: false, description: 'Window in hours (default 24)' })
  @ApiResponse({ status: 200, description: 'Health summary' })
  getSummary(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('hours') hours?: string,
  ) {
    const parsed = Number(hours);
    const window =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 168) : 24;
    return this.integrationsService.getSummary(id, user, window);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update integration' })
  @ApiResponse({ status: 200, description: 'Integration updated successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateIntegrationDto: UpdateIntegrationDto,
  ) {
    return this.integrationsService.update(id, user, updateIntegrationDto);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete integration' })
  @ApiResponse({ status: 204, description: 'Integration deleted successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.integrationsService.remove(id, user);
  }

  @Post(':id/toggle')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Toggle integration status' })
  @ApiResponse({ status: 200, description: 'Status toggled successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  toggleStatus(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.toggleStatus(id, user);
  }

  @Post(':id/test')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Test integration connection',
    description:
      'Probes the endpoint through the same adapter dispatch uses. NOTE this ' +
      'sends a real test payload (webhook/HTTP POST, MQTT publish, AWS IoT ' +
      'publish), so subscribers will see it. Returns ' +
      '{ connected, message, latencyMs }.',
  })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  testConnection(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.testConnection(id, user);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TUYA
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Declared before the `:id/...` Tuya routes purely for readability — Nest
   * matches on the literal segments, and 'tuya/webhook' cannot be confused
   * with any of them.
   */
  // ── LoRaWAN uplink webhooks ───────────────────────────────────────────────
  // Declared before the `:id/...` routes for readability; Nest matches on the
  // literal segments, so 'lorawan/*' cannot be confused with them.

  @Post('lorawan/chirpstack')
  @Public()
  @HttpCode(HttpStatus.OK)
  // A gateway serving many devices bursts well past the global 100/min, and a
  // 429 would make ChirpStack retry and eventually disable the integration.
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @ApiOperation({
    summary: 'ChirpStack uplink webhook',
    description:
      'Unauthenticated — ChirpStack calls this directly (Application → ' +
      'Integrations → HTTP). Auto-creates the device by DevEUI on first sight ' +
      'and ingests the uplink through the normal pipeline (codec decode → ' +
      'Kafka → persist + alarms + WebSocket).\n\n' +
      'Tenant resolution, first match wins: (1) X-Tenant-Id header — still ' +
      'validated against an active chirpstack integration, never trusted on ' +
      'its own; (2) applicationId query param matched against ' +
      'configuration.applicationId; (3) the application id in the body; ' +
      '(4) the single active chirpstack integration, if there is exactly one. ' +
      'Ambiguity is rejected rather than guessed.\n\n' +
      'ALWAYS responds 200 — check the `success` field — because ChirpStack ' +
      'disables an integration that keeps failing. Set ' +
      'configuration.webhookSecret to require a matching x-webhook-secret header.',
  })
  @ApiQuery({
    name: 'applicationId',
    required: false,
    description: 'Matched against the integration configuration.applicationId.',
  })
  @ApiHeader({
    name: 'x-tenant-id',
    required: false,
    description: 'Target tenant. Must own an active chirpstack integration.',
  })
  @ApiHeader({
    name: 'x-webhook-secret',
    required: false,
    description:
      'Required only when the integration has configuration.webhookSecret set.',
  })
  @ApiResponse({ status: 200, description: 'Uplink accepted' })
  chirpstackWebhook(
    @Body() body: any,
    @Query('applicationId') applicationId?: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-webhook-secret') webhookSecret?: string,
  ) {
    return this.lorawanService.handleChirpStackWebhook(
      body,
      applicationId,
      tenantId,
      webhookSecret,
    );
  }

  @Post('lorawan/ttn')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @ApiOperation({
    summary: 'TTN (The Things Stack v3) uplink webhook',
    description:
      'Unauthenticated — The Things Stack calls this directly (Application → ' +
      'Integrations → Webhooks). Same behaviour as the ChirpStack route; the ' +
      'envelope differs (snake_case, end_device_ids.dev_eui, ' +
      'uplink_message.decoded_payload), which is why it is a separate route.\n\n' +
      'ALWAYS responds 200 — check the `success` field.',
  })
  @ApiQuery({
    name: 'applicationId',
    required: false,
    description: 'Matched against the integration configuration.applicationId.',
  })
  @ApiHeader({
    name: 'x-tenant-id',
    required: false,
    description: 'Target tenant. Must own an active ttn integration.',
  })
  @ApiHeader({
    name: 'x-webhook-secret',
    required: false,
    description:
      'Required only when the integration has configuration.webhookSecret set.',
  })
  @ApiResponse({ status: 200, description: 'Uplink accepted' })
  ttnWebhook(
    @Body() body: any,
    @Query('applicationId') applicationId?: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-webhook-secret') webhookSecret?: string,
  ) {
    return this.lorawanService.handleTtnWebhook(
      body,
      applicationId,
      tenantId,
      webhookSecret,
    );
  }

  // ── Generic HTTP uplink ───────────────────────────────────────────────────

  @Post('http/:id')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Same reasoning as the LoRaWAN webhooks: one gateway serving many devices
  // bursts past the global 100/min, and a 429 makes the sender retry and
  // eventually disable the destination.
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @ApiOperation({
    summary: 'Generic HTTP uplink for an integration',
    description:
      'The endpoint any HTTP-push source can target — Loriot, Sigfox, a vendor ' +
      'cloud, a gateway script. The URL names the INTEGRATION (unlike ' +
      'POST /api/v1/ingestion/:deviceKey, where the URL names the device); the ' +
      "device is found in the body using the integration's own field mapping, " +
      'so a source that cannot be told to put the device id in a path still ' +
      'works.\n\n' +
      'Authentication is the integration\'s `configuration.routingKey`, sent as ' +
      'the `x-routing-key` header or the `routingKey` query parameter, and ' +
      'compared in constant time. It is REQUIRED — an open route that writes ' +
      "telemetry against a named tenant is not something to leave unguarded.\n\n" +
      'ALWAYS responds 200 — check the `success` field. Unknown devices are ' +
      'rejected rather than auto-created: an arbitrary HTTP source can send any ' +
      'string, and provisioning per unrecognised value would let a ' +
      "misconfigured sender exhaust the tenant's device quota.",
  })
  @ApiHeader({
    name: 'x-routing-key',
    required: false,
    description:
      "Must match the integration's configuration.routingKey. May be sent as " +
      'the `routingKey` query parameter instead.',
  })
  @ApiResponse({
    status: 200,
    description: '{ success, message, deviceId?, deviceKey? }',
  })
  httpUplink(
    @Param('id') id: string,
    @Body() body: any,
    @Headers('x-routing-key') headerKey?: string,
    @Query('routingKey') queryKey?: string,
  ) {
    return this.uplinkService.handleUplink(id, body, headerKey ?? queryKey);
  }

  @Post('tuya/webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Tuya pushes one delivery per device event; a busy account bursts well past
  // the global 100/min, and a 429 would make Tuya retry and eventually disable
  // the subscription.
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @ApiOperation({
    summary: 'Tuya webhook receiver (real-time device events)',
    description:
      'Unauthenticated — Tuya calls this directly. The integration is resolved ' +
      "from the `client_id` header (or the body) matched against " +
      "configuration.clientId. ALWAYS responds 200 {success:true}, even for " +
      'unknown clients or malformed payloads, because Tuya disables a ' +
      'subscription that keeps failing. Set configuration.webhookSecret to ' +
      'additionally require a matching x-webhook-secret header.',
  })
  @ApiHeader({
    name: 'client_id',
    required: false,
    description:
      'Tuya project client id. Falls back to clientId/client_id in the body.',
  })
  @ApiHeader({
    name: 'x-webhook-secret',
    required: false,
    description:
      'Required only when the integration has configuration.webhookSecret set.',
  })
  @ApiResponse({ status: 200, description: 'Event accepted' })
  tuyaWebhook(
    @Body() body: any,
    @Headers('client_id') clientId?: string,
    @Headers('x-webhook-secret') webhookSecret?: string,
  ) {
    return this.integrationsService.handleTuyaWebhook(
      body,
      clientId,
      webhookSecret,
    );
  }

  @Post(':id/tuya/sync')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import Tuya devices into the platform',
    description:
      'Creates a Device (plus TUYA credentials holding its local_key) for every ' +
      'device bound to the Tuya project, updates the ones already imported, and ' +
      'stores their current datapoints as telemetry. Idempotent — re-running ' +
      'updates instead of duplicating. Runs automatically when a Tuya ' +
      'integration is created, updated or enabled while active.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync result: { created, updated, failed, total, devices[] }',
  })
  @ApiResponse({
    status: 400,
    description: 'Not a Tuya integration, or Tuya rejected the device lookup',
  })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  syncTuyaDevices(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.syncTuyaDevices(id, user);
  }

  @Get(':id/tuya/devices')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'List Tuya devices bound to this integration',
    description:
      'Requires a TUYA integration (or a legacy CLOUD one carrying Tuya credentials).',
  })
  @ApiResponse({ status: 200, description: 'Tuya devices' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  getTuyaDevices(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.getTuyaDevices(id, user);
  }

  @Post(':id/tuya/command')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a command to a Tuya device',
    description:
      'Body: { tuyaDeviceId, commands: [{ code, value }] }. Commands are passed ' +
      'through to POST /v1.0/devices/{id}/commands on the Tuya OpenAPI.',
  })
  @ApiResponse({ status: 200, description: 'Command accepted by Tuya' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration, or Tuya rejected the command' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  sendTuyaCommand(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: TuyaCommandDto,
  ) {
    return this.integrationsService.sendTuyaCommand(id, user, body);
  }

  @Get(':id/tuya/device/:tuyaDeviceId/status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get the current datapoint status of a Tuya device' })
  @ApiResponse({ status: 200, description: 'Tuya device status' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration, or Tuya rejected the request' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  getTuyaDeviceStatus(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('tuyaDeviceId') tuyaDeviceId: string,
  ) {
    return this.integrationsService.getTuyaDeviceStatus(id, user, tuyaDeviceId);
  }
}
