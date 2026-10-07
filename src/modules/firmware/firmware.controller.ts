import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { File as MulterFile } from 'multer';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { FirmwareService } from './firmware.service';
import { CreateFirmwareDto } from './dto/create-firmware.dto';
import { AssignFirmwareDto } from './dto/assign-firmware.dto';
import { UpdateFirmwareDto } from './dto/update-firmware.dto';
import { QueryFirmwareDto } from './dto/query-firmware.dto';
import { QueryOtaRolloutDto } from './dto/ota-rollout.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Firmware packages + OTA rollout — the operator-facing half.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The device-facing half is OtaController (/ota/:deviceToken/*), authenticated
 * by device token rather than JWT.
 *
 * AUTHORIZATION — read this before copying the pattern elsewhere.
 *
 * Two layers, deliberately:
 *
 *   @Roles(...)               coarse, and the one that actually bites today.
 *   @RequirePermissions(...)  fine-grained, via the global PermissionGuard.
 *
 * `@RequirePermissions` had ZERO usages anywhere in this codebase before this
 * controller — the whole permission system (entity, join tables, seeds,
 * resolution logic, a registered global guard) was built and then never applied
 * to a single route. These are the first routes that exercise PermissionGuard,
 * so the belt-and-braces is intentional while that path earns trust.
 *
 * What PermissionGuard actually does, which matters for who can reach these:
 *   - SUPER_ADMIN and TENANT_ADMIN bypass it entirely. Both get in regardless of
 *     what permissions they hold, so adding these decorators cannot lock an
 *     admin out of firmware.
 *   - CUSTOMER / CUSTOMER_USER / USER are resolved as
 *     union(role permissions, direct permissions), filtered by subscription
 *     features, then INTERSECTED with their customer's `grantedPermissions`.
 *     A customer row with no grants denies everything — so a customer user will
 *     not see firmware until `firmware:*` is granted to their customer.
 *   - Metadata is read from the HANDLER only. A class-level
 *     @RequirePermissions would be ignored, which is why every route carries
 *     its own.
 *
 * The `firmware:*` permission rows are created by permissions.seeder.ts, which
 * upserts rather than early-returning on a non-empty table — otherwise they
 * would never reach an existing database.
 */
@ApiTags('firmware')
@Controller('firmware')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class FirmwareController {
  constructor(private readonly firmwareService: FirmwareService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // OTA rollout
  //
  // ROUTE ORDER: these sit above every ':id' route on purpose. Nest matches in
  // declaration order, so `@Get(':id')` declared first would swallow
  // GET /firmware/ota/rollout and hand 'ota' to ParseIdPipe as a UUID.
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('ota/summary')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('firmware:read')
  @ApiOperation({
    summary: 'Device counts per OTA rollout state (stat cards)',
  })
  @ApiResponse({
    status: 200,
    description:
      'UP_TO_DATE / PENDING / IN_PROGRESS / UPDATED / FAILED counts plus totalDevices',
  })
  otaSummary(@CurrentUser() user: User) {
    return this.firmwareService.getRolloutSummary(user.tenantId);
  }

  @Get('ota/rollout')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('firmware:read')
  @ApiOperation({
    summary: 'Per-device OTA rollout status',
    description:
      'One row per device with its derived rolloutState, target version, progress and last error.',
  })
  otaRollout(@CurrentUser() user: User, @Query() query: QueryOtaRolloutDto) {
    return this.firmwareService.getRollout(user.tenantId, query);
  }

  @Post('ota/:deviceId/retry')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('firmware:assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a failed update on one device',
    description:
      'Keeps the same target version and re-publishes the OTA command. Requires the device to still have a pending version.',
  })
  otaRetry(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.firmwareService.retryDeviceUpdate(deviceId, user.tenantId);
  }

  @Post('ota/:deviceId/cancel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('firmware:assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a pending update on one device',
    description:
      'Clears the pending version. A download already in flight completes but nothing is flashed.',
  })
  otaCancel(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.firmwareService.cancelDeviceUpdate(deviceId, user.tenantId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Package CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('firmware:create')
  @ApiOperation({ summary: 'Upload a new firmware package' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: User,
    @UploadedFile() file: MulterFile,
    @Body() dto: CreateFirmwareDto,
  ) {
    return this.firmwareService.create(
      user.id,
      user.tenantId,
      user.customerId ?? null,
      dto,
      file,
    );
  }

  @Get()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('firmware:read')
  @ApiOperation({
    summary: 'List firmware packages',
    description:
      'Each row carries assignedDeviceCount and installedDeviceCount so a package in use is visible before it is deleted.',
  })
  findAll(@CurrentUser() user: User, @Query() query: QueryFirmwareDto) {
    return this.firmwareService.findAll(user.tenantId, query);
  }

  @Get(':id')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('firmware:read')
  @ApiOperation({ summary: 'Get firmware package by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.firmwareService.findOne(id, user.tenantId);
  }

  @Get(':id/download')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('firmware:read')
  @ApiOperation({
    summary: 'Download the uploaded binary (operator)',
    description:
      'Tenant-scoped. Distinct from GET /ota/:deviceToken/download, which is device-authenticated and only serves that device’s pending version.',
  })
  async download(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { firmware, absolutePath } =
      await this.firmwareService.getFileForOperator(id, user.tenantId);

    // @Res() means the global TransformInterceptor's { success, data } envelope
    // is bypassed — a binary must not be JSON-wrapped.
    res.set({
      'Content-Type': firmware.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${firmware.fileName}"`,
      'Content-Length': String(firmware.size),
      'X-Firmware-Checksum': firmware.checksum,
      'X-Firmware-Version': firmware.version,
    });
    createReadStream(absolutePath).pipe(res);
  }

  @Get(':id/devices')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('firmware:read')
  @ApiOperation({
    summary: 'Devices this package is assigned to or installed on',
  })
  findDevices(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.firmwareService.getFirmwareDevices(id, user.tenantId);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('firmware:update')
  @ApiOperation({
    summary: 'Update package metadata',
    description:
      'Title, description, target profile and active state only. Version, binary and checksum are immutable — devices resolve their pending update by version string, so renaming one would strand every device already waiting on it.',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdateFirmwareDto,
  ) {
    return this.firmwareService.update(id, user.tenantId, user.id, dto);
  }

  @Post(':id/assign')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('firmware:assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a firmware version to a device or device profile',
  })
  assign(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AssignFirmwareDto,
  ) {
    return this.firmwareService.assign(id, user.tenantId, dto);
  }

  @Post(':id/unassign')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('firmware:assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear this package from every device still waiting on it',
  })
  unassign(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.firmwareService.unassign(id, user.tenantId);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('firmware:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a firmware package',
    description:
      'Refused with 400 while devices are still waiting on this version, because deleting it strands them silently. Pass force=true to unassign them as part of the delete.',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    description: 'Unassign waiting devices instead of refusing',
  })
  remove(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('force') force?: string,
  ) {
    return this.firmwareService.remove(id, user.tenantId, force === 'true');
  }
}
