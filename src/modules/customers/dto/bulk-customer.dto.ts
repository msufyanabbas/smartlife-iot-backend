// src/modules/customers/dto/bulk-customer.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { BulkIdsDto } from '@common/dto/bulk-operation.dto';
import { CustomerStatus } from '@common/enums/index.enum';

export class BulkDeleteCustomersDto extends BulkIdsDto {}

/**
 * The allowed bulk customer patch — `status`, and nothing else.
 *
 * NOT ALLOWED:
 *   - `allocatedLimits` — every write has to be validated against the
 *     tenant's remaining subscription capacity
 *     (`CustomersService.validateAllocatedLimits`), and that check is about
 *     the SUM of all customers' allocations. Applying one value to 50
 *     customers would have to be validated as a set, not per row, and a
 *     half-applied batch would leave the tenant over-allocated. It stays on
 *     `PATCH /customers/:id`.
 *   - `grantedPermissions` — the permission ceiling for every user under the
 *     customer. Granting a permission to 50 customer orgs in one request is
 *     the definition of a privilege-escalation hole.
 *   - `email` / `phone` / `name` — per-customer identity, UNIQUE on email, and
 *     meaningless as a shared value for a batch.
 *   - `tenantId` — the security boundary; never writable from a body.
 */
export class BulkUpdateCustomersDto extends BulkIdsDto {
  @ApiPropertyOptional({
    type: String,
    enum: CustomerStatus,
    enumName: 'CustomerStatus',
    description: 'New status for every listed customer.',
  })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
