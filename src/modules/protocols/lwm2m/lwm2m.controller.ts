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
  // RolesGuard returns true for a handler with no @Roles metadata, so every
  // handler in this file carries an explicit decorator.
  @TenantOrCustomerAdmin()
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
  @ApiOperation({
    summary: 'Live LwM2M client registrations',
    description:
      'Registrations are held in the process that owns the CoAP UDP socket, ' +
      'so this reflects one node only and is empty after a restart until ' +
      'clients re-register. `secondsUntilExpiry` counts down the registration ' +
      'lifetime (plus LWM2M_LIFETIME_GRACE_SECONDS); when it reaches zero the ' +
      'registration is dropped and the device is marked offline.',
  })
  @ApiResponse({ status: 200, description: 'Registrations for your tenant' })
  listRegistrations(@CurrentUser() user: User): Lwm2mRegistrationView[] {
    // Tenant scoping comes from the caller's JWT, never from a query param.
    // SUPER_ADMIN is the only role that sees across tenants, matching how
    // DevicesService.applyAccessFilter() treats it.
    const tenantId =
      user.role === UserRole.SUPER_ADMIN ? undefined : user.tenantId;
    return this.lwm2mService.listRegistrations(tenantId);
  }

  @Get('registrations/:endpoint')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'One registration by LwM2M endpoint name (== deviceKey)',
  })
  @ApiResponse({ status: 200, description: 'Registration, or null when the endpoint is not registered' })
  getRegistration(
    @CurrentUser() user: User,
    @Param('endpoint') endpoint: string,
  ): Lwm2mRegistrationView | null {
    const tenantId =
      user.role === UserRole.SUPER_ADMIN ? undefined : user.tenantId;
    return (
      this.lwm2mService
        .listRegistrations(tenantId)
        .find((r) => r.endpoint === endpoint) ?? null
    );
  }
}
