// src/modules/users/dto/bulk-user.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { BulkIdsDto } from '@common/dto/bulk-operation.dto';
import { UserStatus } from '@common/enums/index.enum';

export class BulkDeleteUsersByIdDto extends BulkIdsDto {}

/**
 * The allowed bulk user patch — two fields, and the omissions are the point.
 *
 * NOT ALLOWED, and why each one is a privilege-escalation hole in bulk:
 *   - `role`      — one request could promote 100 accounts to TENANT_ADMIN, or
 *                   demote every admin but the caller. Role changes belong on
 *                   `PATCH /users/:id`, one reviewable decision at a time.
 *   - `password`  — a bulk password write is an account-takeover primitive: it
 *                   sets credentials the account holder did not choose and was
 *                   not told about. Password changes go through
 *                   `POST /users/change-password` (needs the current password)
 *                   or the reset-token flow.
 *   - `tenantId`  — the tenant id is the security boundary of this platform.
 *                   Letting a request body move rows across it would make
 *                   every other tenant check decorative.
 *   - `email`     — the login identifier and the reset-token destination.
 *                   `UsersService.update()` has to check uniqueness and
 *                   re-issue a verification token per user; a shared value for
 *                   a batch is meaningless anyway (email is UNIQUE).
 *
 * ALLOWED:
 *   - `status`     — the actual bulk need: suspend / reactivate / deactivate a
 *                    set of accounts. Already a single-user route
 *                    (`PATCH /users/:id/status`).
 *   - `customerId` — move a batch of users into a customer org, or `null` to
 *                    detach. This re-scopes which customer's data they see,
 *                    which is tenant-internal authority a TENANT_ADMIN already
 *                    has per user; the target customer is checked against the
 *                    caller's own tenant, which is the part that matters.
 */
export class BulkUpdateUsersDto extends BulkIdsDto {
  @ApiPropertyOptional({
    type: String,
    enum: UserStatus,
    enumName: 'UserStatus',
    description: 'New account status for every listed user.',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Customer org to move these users into, or null to detach. Must belong to the caller’s tenant.',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string | null;
}
