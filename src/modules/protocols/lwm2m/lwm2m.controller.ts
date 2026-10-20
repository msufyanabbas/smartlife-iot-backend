// src/modules/protocols/lwm2m/lwm2m.controller.ts
//
// The REST surface that lets the frontend show what LwM2M actually does here.
// `GET /lwm2m/capabilities` is the point of this controller: the transport is
// selectable on a device profile, and without a machine-readable scope list
// the UI has no way to tell an operator that Observe/Notify, server-initiated
// Read/Write/Execute, Bootstrap and DTLS are not implemented.

import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { TenantOrCustomerAdmin } from '@common/decorators/access-control.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';
import {
  Lwm2mService,
  type Lwm2mRegistrationView,
} from './lwm2m.service';
import {
  LWM2M_CAPABILITIES,
  LWM2M_SCOPE_SUMMARY,
  type Lwm2mCapability,
} from './lwm2m.scope';

@ApiTags('LwM2M')
@ApiBearerAuth()
@Controller('lwm2m')
export class Lwm2mController {
  constructor(private readonly lwm2mService: Lwm2mService) {}

  // ── Capability matrix ─────────────────────────────────────────────────────

  @Get('capabilities')
  // RolesGuard returns true for a handler with no @Roles metadata, and
  // PermissionGuard returns true for one with no @RequirePermissions, so every
  // handler in this file carries both.
  @TenantOrCustomerAdmin()
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'What this platform\'s LwM2M support does and does not do',
    description:
      'Static, machine-readable scope of the LwM2M transport, for the device-' +
      'profile UI to render next to transportType=LWM2M. Implemented: ' +
      'Register, Update, De-register, Send (SenML JSON). NOT implemented: ' +
      'Observe/Notify, server-initiated Read/Write/Execute, Bootstrap, DTLS, ' +
      'SenML CBOR/TLV, Queue Mode. The two `lwm2m` profile settings ' +
      '`observeOnConnect` and `bootstrapServerUpdateEnabled` are stored but ' +
      'inert, and this endpoint says so.',
  })
  @ApiResponse({ status: 200, description: 'Capability matrix' })
  getCapabilities(): {
    summary: typeof LWM2M_SCOPE_SUMMARY;
    capabilities: Lwm2mCapability[];
  } {
    // TransformInterceptor already wraps this as { success, data, timestamp };
    // returning the payload itself keeps it at .data rather than .data.data.
    return {
      summary: LWM2M_SCOPE_SUMMARY,
      capabilities: LWM2M_CAPABILITIES,
    };
  }

  // ── Live registrations ────────────────────────────────────────────────────

  @Get('registrations')
  @TenantOrCustomerAdmin()
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'Live LwM2M client registrations',
    description:
      'Read from `lwm2m_registrations`, which is authoritative — so this ' +
      'survives a restart and is the same answer on every replica. (It used ' +
      "to report one node's in-process memory, and was empty after a deploy " +
      'while the registrations themselves were still live.) ' +
      '`secondsUntilExpiry` counts down the registration lifetime plus ' +
      'LWM2M_LIFETIME_GRACE_SECONDS; when it reaches zero the registration is ' +
      'dropped and the device is marked offline. `endpoint` is the device ' +
      'key — the endpoint NAME is a credential and is only stored hashed.',
  })
  @ApiResponse({ status: 200, description: 'Registrations for your tenant' })
  listRegistrations(
    @CurrentUser() user: User,
  ): Promise<Lwm2mRegistrationView[]> {
    // Tenant scoping comes from the caller's JWT, never from a query param.
    // SUPER_ADMIN is the only role that sees across tenants, matching how
    // DevicesService.applyAccessFilter() treats it.
    const tenantId =
      user.role === UserRole.SUPER_ADMIN ? undefined : user.tenantId;
    return this.lwm2mService.listRegistrations(tenantId);
  }

  @Get('registrations/:endpoint')
  @TenantOrCustomerAdmin()
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'One registration by device key',
    description:
      'The path segment is the DEVICE KEY, not the raw LwM2M endpoint name — ' +
      'the latter is the credential the client authenticates with and is ' +
      'never accepted or returned here.',
  })
  @ApiResponse({ status: 200, description: 'Registration, or null when the device is not registered' })
  async getRegistration(
    @CurrentUser() user: User,
    @Param('endpoint') endpoint: string,
  ): Promise<Lwm2mRegistrationView | null> {
    // Filtered from the tenant-scoped list rather than looked up directly, so
    // a caller cannot read another tenant's registration by naming its device
    // key — and gets 200/null rather than a 403 that would confirm it exists
    // (CLAUDE.md §4g).
    const tenantId =
      user.role === UserRole.SUPER_ADMIN ? undefined : user.tenantId;
    const registrations = await this.lwm2mService.listRegistrations(tenantId);
    return registrations.find((r) => r.endpoint === endpoint) ?? null;
  }
}
