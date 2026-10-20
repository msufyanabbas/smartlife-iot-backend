// src/modules/relations/relations.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RelationsService } from './relations.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import {
  DeleteEntityRelationsQueryDto,
  DeleteRelationQueryDto,
  EntityRelationQueryDto,
  RelationGraphQueryDto,
  RelationTypeQueryDto,
} from './dto/relation-query.dto';

import { Roles } from '@common/decorators/roles.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { UserRole } from '@common/enums/index.enum';
import { COMMON_RELATION_TYPES, RelationEntityType } from '@common/enums/relation.enum';
import { User } from '@modules/users/entities/user.entity';

/**
 * The entity-relation graph.
 *
 * Every handler carries `@Roles(...)` — `RolesGuard` returns **true** for a
 * handler with no `@Roles` metadata, so an undecorated route here would let
 * any authenticated account on the platform draw edges between another
 * tenant's entities (§4g). Reads are open to CUSTOMER because the Relations
 * tab is on pages a customer admin can already see; writes are TENANT_ADMIN,
 * because a relation is part of the tenant's model of its own plant, not a
 * per-customer preference.
 *
 * SUPER_ADMIN is not listed. It is legitimately tenant-less, a relation has no
 * meaning without a tenant, and the alternative — widening every signature to
 * `string | undefined` — is exactly how a falsy tenantId ends up leaving a
 * query unscoped. `tenantOf()` says so in words instead.
 *
 * Every handler also carries `@RequirePermissions(...)`, which is a different
 * gate from `@Roles` and not a duplicate of it: `@Roles` checks the coarse
 * role, `@RequirePermissions` checks the fine-grained grant, and
 * `PermissionGuard` returns **true** for a handler with no metadata — so an
 * undecorated route here would be one of the open ones §4k exists to close.
 *
 * The strings are `assets:*`, and deliberately so:
 *
 *  · A relation is structure **about** the asset model — "building contains
 *    floor", "pump feeds tank" — so the asset vocabulary is the one a grant
 *    already means something in. Inventing a `relations` resource would need
 *    seeder rows and a backfill, and an unseeded string can never be granted:
 *    it is a permanent 403 that reads as a bug in the guard.
 *  · Writes are **`assets:update`**, not `assets:create` / `assets:delete`.
 *    Adding or removing an edge edits the model and creates or destroys no
 *    entity — the same classification §4k settled for
 *    `DELETE /assets/:id/devices/:deviceId`.
 *  · `GET /relations/type` is tenant-wide, so it takes `assets:list` rather
 *    than `assets:read`.
 */
@ApiTags('relations')
@Controller('relations')
@ApiBearerAuth()
export class RelationsController {
  constructor(private readonly relations: RelationsService) {}

  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'Relations belong to a tenant. Sign in as a tenant administrator, or select a tenant first.',
      );
    }
    return user.tenantId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The vocabulary the "Add relation" form is generated from, so the frontend
   * does not keep its own copy of the entity types and drift from the server's.
   */
  @Get('vocabulary')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER)
  @RequirePermissions('assets:read')
  @ApiOperation({ summary: 'Entity types and the suggested relation types' })
  vocabulary() {
    return {
      entityTypes: Object.values(RelationEntityType),
      relationTypes: [...COMMON_RELATION_TYPES],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  //
  // Static segments are declared before `:id` so that "graph", "from", "to",
  // "type" and "entity" are never captured as a relation id.
  // ══════════════════════════════════════════════════════════════════════════

  @Get('from')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER)
  @RequirePermissions('assets:read')
  @ApiOperation({
    summary: 'Outbound relations — what this entity relates TO',
    description:
      'Each row carries the other endpoint’s resolved name, so a list needs no follow-up request per row.',
  })
  @ApiResponse({ status: 404, description: 'The entity is not in this tenant' })
  findByFrom(@CurrentUser() user: User, @Query() query: EntityRelationQueryDto) {
    return this.relations.findByFrom(
      query.entityType,
      query.entityId,
      this.tenantOf(user),
      { relationType: query.relationType, relationGroup: query.relationGroup },
    );
  }

  @Get('to')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER)
  @RequirePermissions('assets:read')
  @ApiOperation({ summary: 'Inbound relations — what relates TO this entity' })
  findByTo(@CurrentUser() user: User, @Query() query: EntityRelationQueryDto) {
    return this.relations.findByTo(
      query.entityType,
      query.entityId,
      this.tenantOf(user),
      { relationType: query.relationType, relationGroup: query.relationGroup },
    );
  }

  /**
   * Both directions in one request. The Relations tab renders inbound and
   * outbound side by side, and two round trips for one panel is two spinners.
   */
  @Get('entity')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER)
  @RequirePermissions('assets:read')
  @ApiOperation({ summary: 'Inbound and outbound relations for one entity' })
  findForEntity(
    @CurrentUser() user: User,
    @Query() query: EntityRelationQueryDto,
  ) {
    return this.relations.findForEntity(
      query.entityType,
      query.entityId,
      this.tenantOf(user),
      { relationType: query.relationType, relationGroup: query.relationGroup },
    );
  }

  @Get('type')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('assets:list')
  @ApiOperation({ summary: 'Every relation of one type in this tenant' })
  findByType(@CurrentUser() user: User, @Query() query: RelationTypeQueryDto) {
    return this.relations.findByType(query.relationType, this.tenantOf(user), {
      relationGroup: query.relationGroup,
      limit: query.limit,
    });
  }

  /**
   * The recursive traversal: nodes + edges reachable from one root.
   *
   * `maxDepth` is a request, not a ceiling — it is clamped to
   * `RELATION_GRAPH_MAX_DEPTH`. The walk has a cycle guard as well, because a
   * user can legitimately draw `A feeds B feeds A` and an unguarded recursive
   * CTE over that does not return (§4b).
   */
  @Get('graph')
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER)
  @RequirePermissions('assets:read')
  @ApiOperation({
    summary: 'Recursive graph traversal from one root entity',
    description:
      'Cycle-guarded and depth-bounded. `truncated: true` means the edge cap stopped the walk and the picture is partial.',
  })
  @ApiQuery({
    name: 'direction',
    required: false,
    enum: ['FROM', 'TO'],
    description: 'FROM walks downstream, TO walks upstream. Default FROM.',
  })
  graph(@CurrentUser() user: User, @Query() query: RelationGraphQueryDto) {
    return this.relations.buildGraph(
      {
        rootType: query.rootType,
        rootId: query.rootId,
        direction: query.direction,
        maxDepth: query.maxDepth,
        relationType: query.relationType,
        relationGroup: query.relationGroup,
      },
      this.tenantOf(user),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITES
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
  @Roles(UserRole.TENANT_ADMIN)
  @RequirePermissions('assets:update')
  @ApiOperation({
    summary: 'Create a relation',
    description:
      'Both endpoints are resolved against their own table, pinned to the caller’s tenant, before the row is written — otherwise relations become dangling.',
  })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 404, description: 'An endpoint is not in this tenant' })
  @ApiResponse({ status: 409, description: 'That relation already exists' })
  create(@CurrentUser() user: User, @Body() dto: CreateRelationDto) {
    return this.relations.create(dto, this.tenantOf(user), user.id);
  }

  /**
   * Delete every relation touching one entity, both directions.
   *
   * Declared before `DELETE /:id` so the literal segment wins, and
   * TENANT_ADMIN only: it is the one call here that can remove a hundred rows.
   */
  @Delete('entity')
  @Roles(UserRole.TENANT_ADMIN)
  @RequirePermissions('assets:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete all relations of one entity (both directions)' })
  deleteAllForEntity(
    @CurrentUser() user: User,
    @Query() query: DeleteEntityRelationsQueryDto,
  ) {
    return this.relations.deleteAllForEntity(
      query.entityType,
      query.entityId,
      this.tenantOf(user),
      query.relationGroup,
    );
  }

  /** Delete one relation named by its 6-tuple (the ThingsBoard-shaped call). */
  @Delete()
  @Roles(UserRole.TENANT_ADMIN)
  @RequirePermissions('assets:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one relation by its endpoints and type' })
  @ApiResponse({ status: 404, description: 'Relation not found in this tenant' })
  deleteRelation(
    @CurrentUser() user: User,
    @Query() query: DeleteRelationQueryDto,
  ) {
    return this.relations.deleteRelation(query, this.tenantOf(user));
  }

  /** Delete one relation by its own id — what a row's delete button calls. */
  @Delete(':id')
  @Roles(UserRole.TENANT_ADMIN)
  @RequirePermissions('assets:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one relation by id' })
  @ApiResponse({ status: 404, description: 'Relation not found in this tenant' })
  deleteById(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.relations.deleteById(id, this.tenantOf(user));
  }
}
