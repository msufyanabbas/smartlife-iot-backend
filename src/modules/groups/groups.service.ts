import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { Customer } from '@modules/customers/entities/customers.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import {
  CreateGroupDto,
  GroupMemberQueryDto,
  GroupQueryDto,
  UpdateGroupDto,
} from './dto/group.dto';
import { GROUP_MEMBER_SOURCES, GroupEntityType } from './group.enum';

@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly memberRepo: Repository<GroupMember>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateGroupDto,
  ): Promise<Group> {
    const name = dto.name.trim();
    await this.assertNameFree(tenantId, dto.entityType, name);
    if (dto.customerId) {
      await this.assertCustomerInTenant(tenantId, dto.customerId);
    }

    // Members are validated BEFORE the transaction opens, so a bad id costs
    // nothing and the 400 lists every offending id at once.
    const ids = this.dedupe(dto.entityIds ?? []);
    if (ids.length) {
      await this.verifyMembers(tenantId, dto.entityType, ids);
    }

    return this.dataSource.transaction(async (manager) => {
      const group = manager.create(Group, {
        tenantId,
        customerId: dto.customerId ?? null,
        userId,
        createdBy: userId,
        name,
        description: dto.description,
        entityType: dto.entityType,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        additionalInfo: dto.additionalInfo,
        memberCount: ids.length,
      });
      const saved = await manager.save(group);

      if (ids.length) {
        await manager.insert(
          GroupMember,
          ids.map((entityId) => ({
            tenantId,
            groupId: saved.id,
            entityId,
            entityType: dto.entityType,
            addedBy: userId,
            createdBy: userId,
          })),
        );
      }

      this.logger.log(
        `Group "${saved.name}" (${saved.id}) created for tenant ${tenantId} — ` +
          `${saved.entityType}, ${ids.length} member(s)`,
      );
      // `memberCount` was set from the same `ids` the memberships were inserted
      // from, inside this transaction, so the caller already has the count.
      return saved;
    });
  }

  async findAll(
    tenantId: string,
    query: GroupQueryDto,
  ): Promise<PaginatedResponseDto<Group>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.groupRepo
      .createQueryBuilder('g')
      .where('g.tenantId = :tenantId', { tenantId });

    if (query.entityType) {
      qb.andWhere('g.entityType = :entityType', {
        entityType: query.entityType,
      });
    }
    if (query.customerId) {
      qb.andWhere('g.customerId = :customerId', {
        customerId: query.customerId,
      });
    }
    if (query.search) {
      qb.andWhere('(g.name ILIKE :search OR g.description ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    const sortable = new Set([
      'name',
      'entityType',
      'memberCount',
      'createdAt',
      'updatedAt',
    ]);
    const sortBy = sortable.has(query.sortBy ?? '') ? query.sortBy! : 'name';

    const [rows, total] = await qb
      .orderBy(`g.${sortBy}`, query.sortOrder ?? 'ASC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(rows, page, limit, total);
  }

  /**
   * Returns the group plus the LIVE membership count next to the denormalised
   * one. If they ever diverge it is visible here rather than silently wrong on
   * the list page.
   */
  async findOne(tenantId: string, id: string) {
    const group = await this.groupRepo.findOne({ where: { id, tenantId } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    const countedMembers = await this.memberRepo.count({
      where: { groupId: group.id },
    });

    return { ...group, countedMembers };
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    dto: UpdateGroupDto,
  ): Promise<Group> {
    const group = await this.groupRepo.findOne({ where: { id, tenantId } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== group.name) {
        await this.assertNameFree(tenantId, group.entityType, name, id);
      }
      group.name = name;
    }
    if (dto.customerId !== undefined) {
      if (dto.customerId) {
        await this.assertCustomerInTenant(tenantId, dto.customerId);
      }
      group.customerId = dto.customerId ?? null;
    }
    if (dto.description !== undefined) group.description = dto.description;
    if (dto.icon !== undefined) group.icon = dto.icon ?? null;
    if (dto.color !== undefined) group.color = dto.color ?? null;
    if (dto.additionalInfo !== undefined) {
      group.additionalInfo = dto.additionalInfo;
    }
    group.updatedBy = userId;

    return this.groupRepo.save(group);
  }

  async remove(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<{ message: string; membershipsRemoved: number }> {
    const group = await this.groupRepo.findOne({ where: { id, tenantId } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    return this.dataSource.transaction(async (manager) => {
      // The FK carries ON DELETE CASCADE, but a group delete is a SOFT delete,
      // so the cascade never fires. Without this the memberships would survive
      // the group and "which groups is this device in?" would keep returning a
      // group the user has deleted.
      const removed = await manager.delete(GroupMember, { groupId: group.id });
      group.deletedBy = userId;
      // softRemove persists the entity with `deleted_at` set, so the
      // `deletedBy` assignment above goes out in the same UPDATE.
      await manager.softRemove(group);

      return {
        message: `Group "${group.name}" deleted`,
        membershipsRemoved: removed.affected ?? 0,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MEMBERSHIP
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Add members in bulk.
   *
   * Idempotent: ids already in the group are reported as `alreadyPresent` and
   * not re-inserted, so a retried request is not an error. Ids that are not the
   * caller's tenant's fail the whole call with 400 and a per-id errors array —
   * an unchecked id array is the usual cross-tenant hole, and a partial success
   * would leave the caller unable to tell which half landed.
   */
  async addMembers(
    tenantId: string,
    groupId: string,
    userId: string,
    entityIds: string[],
  ) {
    const group = await this.groupRepo.findOne({
      where: { id: groupId, tenantId },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const ids = this.dedupe(entityIds);
    await this.verifyMembers(tenantId, group.entityType, ids);

    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.find(GroupMember, {
        where: { groupId, entityId: In(ids) },
        select: ['entityId'],
      });
      const present = new Set(existing.map((m) => m.entityId));
      const toInsert = ids.filter((id) => !present.has(id));

      if (toInsert.length) {
        await manager.insert(
          GroupMember,
          toInsert.map((entityId) => ({
            tenantId,
            groupId,
            entityId,
            entityType: group.entityType,
            addedBy: userId,
            createdBy: userId,
          })),
        );
      }

      const memberCount = await this.syncCount(manager, groupId, userId);

      return {
        message: `${toInsert.length} member(s) added to "${group.name}"`,
        added: toInsert.length,
        alreadyPresent: ids.length - toInsert.length,
        memberCount,
      };
    });
  }

  /**
   * Remove members in bulk. Ids that are not in the group are reported as
   * `notPresent` rather than failing — removal is idempotent for the same
   * reason adding is.
   *
   * Member ids are NOT tenant-validated here, deliberately: the group itself is
   * tenant-scoped, so the delete can only ever touch rows of this tenant's
   * group, and refusing to remove an id whose entity has since been deleted
   * would make an orphaned membership impossible to clear.
   */
  async removeMembers(
    tenantId: string,
    groupId: string,
    userId: string,
    entityIds: string[],
  ) {
    const group = await this.groupRepo.findOne({
      where: { id: groupId, tenantId },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const ids = this.dedupe(entityIds);

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(GroupMember, {
        groupId,
        entityId: In(ids),
      });
      const removed = result.affected ?? 0;
      const memberCount = await this.syncCount(manager, groupId, userId);

      return {
        message: `${removed} member(s) removed from "${group.name}"`,
        removed,
        notPresent: ids.length - removed,
        memberCount,
      };
    });
  }

  /**
   * One page of members, with each entity's current name resolved from its own
   * table.
   *
   * Memberships whose entity row is gone (hard-deleted, or soft-deleted and so
   * invisible to the rest of the platform) are reported with `missing: true`
   * instead of being dropped — otherwise `memberCount` and the list would
   * disagree with no explanation. `DELETE /groups/:id/members/missing` clears
   * them.
   */
  async listMembers(
    tenantId: string,
    groupId: string,
    query: GroupMemberQueryDto,
  ) {
    const group = await this.groupRepo.findOne({
      where: { id: groupId, tenantId },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const [rows, total] = await this.memberRepo.findAndCount({
      where: { groupId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const labels = await this.resolveLabels(
      tenantId,
      group.entityType,
      rows.map((r) => r.entityId),
    );

    const members = rows
      .map((row) => ({
        id: row.id,
        entityId: row.entityId,
        entityType: row.entityType,
        name: labels.get(row.entityId) ?? null,
        missing: !labels.has(row.entityId),
        addedBy: row.addedBy ?? null,
        addedAt: row.createdAt,
      }))
      .filter((m) => (query.includeMissing ? true : !m.missing));

    const missingMembers = await this.countMissing(tenantId, group);

    const paginated = PaginatedResponseDto.create(members, page, limit, total);
    return {
      ...paginated,
      group: {
        id: group.id,
        name: group.name,
        entityType: group.entityType,
        memberCount: group.memberCount,
      },
      missingMembers,
    };
  }

  /**
   * "Which groups is this entity in?"
   *
   * A single index seek on `(tenantId, entityType, entityId)` — the index the
   * membership table declares for exactly this question — then one read of the
   * matching groups. The entity id is NOT validated: an id with no groups
   * correctly answers with an empty list, and making this route 404 on a
   * deleted device would break the device detail page the moment a device is
   * removed.
   */
  async groupsForEntity(
    tenantId: string,
    entityType: GroupEntityType,
    entityId: string,
  ) {
    const memberships = await this.memberRepo.find({
      where: { tenantId, entityType, entityId },
    });
    if (memberships.length === 0) {
      return { entityId, entityType, groups: [] };
    }

    const groups = await this.groupRepo.find({
      where: { id: In(memberships.map((m) => m.groupId)), tenantId },
      order: { name: 'ASC' },
    });

    const addedAt = new Map(
      memberships.map((m) => [m.groupId, m.createdAt] as const),
    );

    return {
      entityId,
      entityType,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        entityType: g.entityType,
        icon: g.icon ?? null,
        color: g.color ?? null,
        memberCount: g.memberCount,
        addedAt: addedAt.get(g.id) ?? null,
      })),
    };
  }

  /** Drop memberships whose entity row no longer exists. */
  async pruneMissing(tenantId: string, groupId: string, userId: string) {
    const group = await this.groupRepo.findOne({
      where: { id: groupId, tenantId },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const source = GROUP_MEMBER_SOURCES[group.entityType];
    const orphans: Array<{ entityId: string }> = await this.memberRepo.query(
      `SELECT m."entityId" AS "entityId"
         FROM entity_group_members m
         LEFT JOIN "${source.table}" e
                ON e.id = m."entityId"
               AND e."${source.tenantColumn}" = $2
               AND e.deleted_at IS NULL
        WHERE m."groupId" = $1
          AND e.id IS NULL`,
      [groupId, tenantId],
    );

    if (orphans.length === 0) {
      return { message: 'No orphaned memberships', removed: 0, memberCount: group.memberCount };
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(GroupMember, {
        groupId,
        entityId: In(orphans.map((o) => o.entityId)),
      });
      const memberCount = await this.syncCount(manager, groupId, userId);
      return {
        message: `${result.affected ?? 0} orphaned membership(s) removed`,
        removed: result.affected ?? 0,
        memberCount,
      };
    });
  }

  async getStatistics(tenantId: string) {
    const groups = await this.groupRepo.find({ where: { tenantId } });
    const totalMembers = await this.memberRepo.count({ where: { tenantId } });

    return {
      total: groups.length,
      totalMembers,
      byEntityType: Object.values(GroupEntityType).reduce<
        Record<string, { groups: number; members: number }>
      >((acc, type) => {
        const forType = groups.filter((g) => g.entityType === type);
        acc[type] = {
          groups: forType.length,
          members: forType.reduce((sum, g) => sum + (g.memberCount ?? 0), 0),
        };
        return acc;
      }, {}),
      largest: [...groups]
        .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))
        .slice(0, 5)
        .map((g) => ({
          id: g.id,
          name: g.name,
          entityType: g.entityType,
          memberCount: g.memberCount,
        })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION & HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Every id must exist AND belong to the caller's tenant.
   *
   * This is the check that keeps a group from becoming a cross-tenant handle:
   * without it, `POST /groups/:id/members` with another tenant's device ids
   * would succeed, and from then on every "members of this group" read — and
   * anything built on group-based assignment — would hand this tenant rows it
   * does not own. An unchecked id array is the usual version of this hole.
   *
   * The table and column names come from `GROUP_MEMBER_SOURCES`, keyed by an
   * `@IsEnum`-validated entity type, and the ids go in as a single `$1`
   * parameter — nothing from the request reaches the SQL text.
   */
  async verifyMembers(
    tenantId: string,
    entityType: GroupEntityType,
    entityIds: string[],
  ): Promise<void> {
    if (entityIds.length === 0) {
      throw new BadRequestException('entityIds must not be empty');
    }

    const source = GROUP_MEMBER_SOURCES[entityType];
    if (!source) {
      throw new BadRequestException(`Unsupported group entityType "${entityType}"`);
    }

    const found: Array<{ id: string }> = await this.memberRepo.query(
      `SELECT id FROM "${source.table}"
        WHERE id = ANY($1::uuid[])
          AND "${source.tenantColumn}" = $2
          AND deleted_at IS NULL`,
      [entityIds, tenantId],
    );
    const ok = new Set(found.map((r) => r.id));
    const rejected = entityIds.filter((id) => !ok.has(id));

    if (rejected.length) {
      throw new BadRequestException({
        message: `${rejected.length} of ${entityIds.length} ${entityType} id(s) do not belong to this tenant`,
        errors: rejected.map(
          (id) =>
            `${entityType} ${id} does not exist in this tenant (or has been deleted)`,
        ),
      });
    }
  }

  private async resolveLabels(
    tenantId: string,
    entityType: GroupEntityType,
    entityIds: string[],
  ): Promise<Map<string, string>> {
    if (entityIds.length === 0) return new Map();
    const source = GROUP_MEMBER_SOURCES[entityType];

    const rows: Array<{ id: string; label: string | null }> =
      await this.memberRepo.query(
        `SELECT id, "${source.labelColumn}" AS label
           FROM "${source.table}"
          WHERE id = ANY($1::uuid[])
            AND "${source.tenantColumn}" = $2
            AND deleted_at IS NULL`,
        [entityIds, tenantId],
      );

    return new Map(rows.map((r) => [r.id, r.label ?? r.id] as const));
  }

  private async countMissing(tenantId: string, group: Group): Promise<number> {
    const source = GROUP_MEMBER_SOURCES[group.entityType];
    const [row] = await this.memberRepo.query(
      `SELECT COUNT(*)::int AS missing
         FROM entity_group_members m
         LEFT JOIN "${source.table}" e
                ON e.id = m."entityId"
               AND e."${source.tenantColumn}" = $2
               AND e.deleted_at IS NULL
        WHERE m."groupId" = $1
          AND e.id IS NULL`,
      [group.id, tenantId],
    );
    return Number(row?.missing ?? 0);
  }

  /** Recount from the membership table and store it, inside the caller's transaction. */
  private async syncCount(
    manager: EntityManager,
    groupId: string,
    userId: string,
  ): Promise<number> {
    const memberCount = await manager.count(GroupMember, { where: { groupId } });
    await manager.update(Group, { id: groupId }, { memberCount, updatedBy: userId });
    return memberCount;
  }

  private async assertNameFree(
    tenantId: string,
    entityType: GroupEntityType,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.groupRepo.findOne({
      where: exceptId
        ? { tenantId, entityType, name, id: Not(exceptId) }
        : { tenantId, entityType, name },
    });
    if (clash) {
      throw new ConflictException(
        `A ${entityType} group named "${name}" already exists in this tenant`,
      );
    }
  }

  private async assertCustomerInTenant(
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    const customer = await this.customerRepo.findOne({
      where: { id: customerId, tenantId },
    });
    if (!customer) {
      throw new BadRequestException(
        `customerId ${customerId} does not exist in this tenant`,
      );
    }
  }

  private dedupe(ids: string[]): string[] {
    return [...new Set(ids)];
  }
}
