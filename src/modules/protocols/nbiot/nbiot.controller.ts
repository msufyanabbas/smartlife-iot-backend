// src/modules/protocols/nbiot/nbiot.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NbIotService } from './nbiot.service';
import {
  CreateNbIotDeviceDto,
  NBIOT_APP_PROTOCOLS,
  UpdateNbIotDeviceDto,
} from './dto/nbiot-device.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { Public } from '@common/decorators/public.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/index.entities';
import { NBIOT_SIGNAL_KEYS } from './nbiot.service';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * NB-IoT devices and the carrier uplink
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every authenticated handler carries `@Roles`, with `SUPER_ADMIN` listed
 * explicitly because `RolesGuard` gives it no bypass (CLAUDE.md §4g). The one
 * `@Public()` route is the carrier push, which authenticates with the
 * integration's routing key instead of a JWT — a carrier platform cannot be
 * given a bearer token.
 */
@ApiTags('NB-IoT')
@Controller('nbiot')
@ApiBearerAuth()
export class NbIotController {
  constructor(private readonly service: NbIotService) {}

  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'NB-IoT devices belong to an organisation. Sign in as a tenant ' +
          'administrator, or select a tenant first.',
      );
    }
    return user.tenantId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE CARRIER PUSH — public, routing-key authenticated
  // ══════════════════════════════════════════════════════════════════════════

  @Post('uplink/:integrationId')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Same reasoning as the LoRaWAN webhooks and the generic HTTP uplink: one
  // carrier platform serving many devices bursts past the global 100/min, and
  // a 429 makes the sender retry and eventually disable the destination.
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @ApiOperation({
    summary: 'Carrier NB-IoT uplink',
    description:
      'The endpoint a carrier IoT platform POSTs each uplink to. The URL names ' +
      'the INTEGRATION; the device is resolved by SIM identity — IMEI, IMSI, ' +
      'ICCID or MSISDN — against the NB-IoT device records.\n\n' +
      'That resolution is why this is not just ' +
      '`POST /integrations/http/:id`: a carrier platform knows the IMEI and ' +
      'the MSISDN, and has never heard of this platform’s deviceKey, so a ' +
      'lookup by key cannot serve it.\n\n' +
      'Radio metrics are normalised from whichever spelling the carrier uses ' +
      '(`rsrp`, `RSRP`, `signalPower`, …), sanity-checked against their ' +
      'physical ranges, and stored as the ordinary telemetry keys ' +
      `${Object.values(NBIOT_SIGNAL_KEYS).join(', ')} — so they chart, alarm ` +
      'and export like any other series.\n\n' +
      'Authentication is the integration’s `configuration.routingKey`, sent as ' +
      'the `x-routing-key` header or the `routingKey` query parameter, and ' +
      'compared in constant time.\n\n' +
      'ALWAYS responds 200 — check the `success` field. A push source that ' +
      'receives an error retries and eventually disables the destination. ' +
      'Unknown SIMs are rejected rather than auto-provisioned: an arbitrary ' +
      'HTTP source can send any IMEI, and creating a device per unrecognised ' +
      'value would let a misconfigured sender exhaust the tenant’s quota.',
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
    description:
      '{ success, message, deviceId?, deviceKey?, matchedBy?, signal?, telemetryKeys? }',
  })
  uplink(
    @Param('integrationId') integrationId: string,
    @Body() body: any,
    @Headers('x-routing-key') headerKey?: string,
    @Query('routingKey') queryKey?: string,
  ) {
    return this.service.handleUplink(
      integrationId,
      body,
      headerKey ?? queryKey,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  @Get('capabilities')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'What NB-IoT support on this platform does and does not do',
    description:
      'Served so the UI can say it rather than implying a protocol that does ' +
      'not exist. NB-IoT is a radio BEARER: the device speaks CoAP, MQTT-SN or ' +
      'HTTP over it, and all three already ingest. What is modelled here is ' +
      'the SIM identity and the radio metrics.',
  })
  getCapabilities() {
    return {
      bearer: 'NB-IoT (LTE Cat-NB1 / NB2)',
      appProtocols: NBIOT_APP_PROTOCOLS,
      implemented: [
        'SIM and module identity (IMSI, IMEI, ICCID, MSISDN, carrier, APN, PLMN, band)',
        'Carrier HTTP push at POST /nbiot/uplink/:integrationId, device resolved by SIM identity',
        'Radio metric normalisation across carrier spellings, with range sanity checks',
        'Radio metrics stored as ordinary telemetry series: ' +
          Object.values(NBIOT_SIGNAL_KEYS).join(', '),
        'Per-device expected reporting interval, so a PSM device is not called offline at minute six',
        'Direct CoAP ingestion on UDP 5683 and MQTT, unchanged — an NB-IoT device needs no new transport',
      ],
      notImplemented: [
        'There is no NB-IoT wire protocol to implement — it is a bearer, and the application protocol is CoAP, MQTT-SN or HTTP',
        'Metric normalisation applies to the carrier push path only. A device talking CoAP or MQTT directly still ingests, but its radio metrics land under whatever key its firmware used — adding the lookup to that hot path needs a bounded device cache first',
        'MQTT-SN is listed as a device protocol but there is no MQTT-SN gateway here; such a device must reach the platform through a translating gateway',
        'No carrier management API is called: SIM activation, suspension and data-usage figures stay in the carrier portal',
        'Downlink scheduling against a sleeping (PSM / eDRX) device is not queued — a command is sent immediately or not at all',
      ],
      signalTelemetryKeys: NBIOT_SIGNAL_KEYS,
      note:
        'RSRP is also promoted to the standard `signalStrength` field, so ' +
        'existing widgets that read signal strength work with no changes.',
    };
  }

  @Get('status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'NB-IoT devices with their last-known signal and report health',
    description:
      '`reportHealth` is judged against each device’s own ' +
      '`expectedReportIntervalSeconds`, not the generic five-minute online ' +
      'window — which would show every healthy once-a-day PSM sensor as ' +
      'offline. It returns `unknown` when no interval is set rather than ' +
      'guessing.',
  })
  getStatus(@CurrentUser() user: User) {
    return this.service.getStatus(this.tenantOf(user));
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: 'NB-IoT device records for this organisation' })
  findAll(@CurrentUser() user: User) {
    return this.service.findAll(this.tenantOf(user));
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: 'One NB-IoT device record' })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not in your organisation',
  })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id, this.tenantOf(user));
  }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.DEVICE,
    description: 'create NB-IoT device',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:create')
  @ApiOperation({
    summary: 'Register an NB-IoT SIM against a device',
    description:
      'At least one of IMEI, IMSI, ICCID or MSISDN is required — without one ' +
      'the carrier push endpoint has nothing to match an uplink against.',
  })
  @ApiResponse({ status: 201, description: 'Created' })
  create(@CurrentUser() user: User, @Body() dto: CreateNbIotDeviceDto) {
    return this.service.create(this.tenantOf(user), user.id, dto);
  }

  @Put(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    description: 'update NB-IoT device',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Update an NB-IoT device record' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNbIotDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    description: 'update NB-IoT device',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Update an NB-IoT device record (alias of PUT)' })
  patch(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNbIotDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.DEVICE,
    description: 'delete NB-IoT device',
    severity: AuditSeverity.WARNING,
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an NB-IoT device record' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(id, this.tenantOf(user));
    return { success: true };
  }
}
