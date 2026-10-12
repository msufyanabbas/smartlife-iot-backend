import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiParam,} from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  SwaggerAuth,
  TenantAdminOnly,
  TenantOrCustomerAdmin,
} from '@common/decorators/access-control.decorator';
import { GroupsService } from './groups.service';
import {
  CreateGroupDto,
  GroupMemberQueryDto,
  GroupMembersDto,
  GroupQueryDto,
  UpdateGroupDto,
} from './dto/group.dto';
import { GroupEntityType } from './group.enum';

/**
 * Entity groups — a named collection of devices, assets, customers or users.
 *
 * Every handler carries an explicit roles decorator. `RolesGuard` returns TRUE
 * when a handler has no `@Roles` metadata, so an undecorated route here would
 * let any authenticated user create groups and read every group's membership.
 * Writes are TENANT_ADMIN and above; the read routes stay open to CUSTOMER so
 * a customer admin can filter by group.
 *
 * Membership ids are validated against the caller's tenant on every add
 * (`GroupsService.verifyMembers`). An unchecked id array is the usual
 * cross-tenant hole here: without the check, adding another tenant's device
 * ids would succeed and every subsequent membership read would hand this
 * tenant rows it does not own.
 */
@ApiTags('Groups')
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get()
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'List entity groups' })
  @SwaggerAuth('List groups', 'Paginated groups')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: GroupQueryDto,
  ) {
    return this.groupsService.findAll(tenantId, query);
  }

  // Must precede `:id`, or the literal is parsed as a group id.
  @Get('statistics')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Group and membership counts per entity type' })
  @SwaggerAuth('Group statistics', 'Counts')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.groupsService.getStatistics(tenantId);
  }

  @Get('for-entity/:entityType/:entityId')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Which groups is this entity in?',
    description:
      'A single index seek on (tenantId, entityType, entityId). Answers with an ' +
      'empty list — not a 404 — for an entity in no groups or one that has been ' +
      'deleted, so a detail page does not break when its subject is removed.',
  })
  /**
   * `@ApiParam` with an explicit `enumName` is **required**, not decoration.
   *
   * Without it, `SchemaObjectFactory.createFromModel()` skips its
   * `createEnumParam()` branch and falls through to
   * `createQueryOrParamSchema()`. There it finds `param.type` holding the enum
   * OBJECT — because **SWC**, which builds `dist`, emits the enum reference as
   * `design:type` where `tsc` reduces a string enum to `String`. A TS enum is
   * a plain object, so `isObjectLiteral()` is true and Swagger walks its
   * members as if they were DTO properties, throwing
   *
   *     A circular dependency has been detected (property key: "DEVICE")
   *
   * at `SwaggerModule.createDocument()` — i.e. the container initialises every
   * module and then exits 1. It reproduces only in the built image, never
   * under ts-node. `npm run check:swagger` runs against `dist` for exactly
   * this reason.
   *
   * `ParseEnumPipe` is the other half: the type annotation alone never
   * validated anything, so any string in the path reached the service.
   */
  @ApiParam({
    name: 'entityType',
    enum: GroupEntityType,
    enumName: 'GroupEntityType',
  })
  @SwaggerAuth('Groups for an entity', 'The entity’s groups')
  groupsForEntity(
    @CurrentUser('tenantId') tenantId: string,
    @Param('entityType', new ParseEnumPipe(GroupEntityType))
    entityType: GroupEntityType,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.groupsService.groupsForEntity(tenantId, entityType, entityId);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'One group',
    description:
      'Returns `countedMembers` — the live count from the membership table — ' +
      'next to the denormalised `memberCount`, so a drift between the two is ' +
      'visible instead of silently wrong on the list page.',
  })
  @SwaggerAuth('Get a group', 'The group')
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.groupsService.findOne(tenantId, id);
  }

  @Get(':id/members')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'One page of members, with each entity’s current name',
    description:
      'Memberships whose entity row no longer exists are counted in ' +
      '`missingMembers` and only listed with `?includeMissing=true`. Clear them ' +
      'with DELETE /groups/:id/members/missing.',
  })
  @SwaggerAuth('List group members', 'Paginated members')
  listMembers(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GroupMemberQueryDto,
  ) {
    return this.groupsService.listMembers(tenantId, id, query);
  }

  @Post()
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Create a group',
    description:
      'Optional `entityIds` seed the group in the same transaction, so there is ' +
      'no window where it exists empty. Every id is tenant-checked first; one ' +
      'foreign id fails the whole create with a per-id errors array.',
  })
  @SwaggerAuth('Create a group', 'Group created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateGroupDto,
  ) {
    return this.groupsService.create(tenantId, userId, dto);
  }

  @Post(':id/members')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Add members in bulk',
    description:
      'Idempotent — ids already in the group come back as `alreadyPresent`. Ids ' +
      'outside the caller’s tenant fail the whole call with 400 rather than ' +
      'landing a partial set nobody can audit. Returns a `message` with the ' +
      'counts, which is part of the result.',
  })
  @SwaggerAuth('Add group members', 'Members added')
  addMembers(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GroupMembersDto,
  ) {
    return this.groupsService.addMembers(tenantId, id, userId, dto.entityIds);
  }

  @Put(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Update a group',
    description:
      '`entityType` cannot be changed — the members are ids in a different ' +
      'table per kind, so flipping it would leave every row pointing at the ' +
      'wrong one. Membership is managed through /groups/:id/members.',
  })
  @SwaggerAuth('Update a group', 'Group updated')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groupsService.update(tenantId, id, userId, dto);
  }

  @Patch(':id')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Update a group (alias of PUT)' })
  @SwaggerAuth('Update a group', 'Group updated')
  patch(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groupsService.update(tenantId, id, userId, dto);
  }

  // Before `DELETE /:id/members`, or "missing" is taken as part of that route's body-less form.
  @Delete(':id/members/missing')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Drop memberships whose entity no longer exists',
    description:
      'Membership rows carry no foreign key — an FK cannot be polymorphic — so ' +
      'deleting a device leaves its memberships behind. This clears them and ' +
      'resyncs the group’s count.',
  })
  @SwaggerAuth('Prune orphaned memberships', 'Orphans removed')
  pruneMissing(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.groupsService.pruneMissing(tenantId, id, userId);
  }

  @Delete(':id/members')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Remove members in bulk',
    description:
      'Takes the same `{ entityIds }` body as the add route. Idempotent — ids ' +
      'not in the group come back as `notPresent`.',
  })
  @SwaggerAuth('Remove group members', 'Members removed')
  removeMembers(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GroupMembersDto,
  ) {
    return this.groupsService.removeMembers(tenantId, id, userId, dto.entityIds);
  }

  @Delete(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Delete a group',
    description:
      'The group is soft-deleted; its membership rows are HARD-deleted in the ' +
      'same transaction. The entities themselves are untouched.',
  })
  @SwaggerAuth('Delete a group', 'Group deleted')
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.groupsService.remove(tenantId, id, userId);
  }
}
