// src/modules/relations/relations.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { EntityRelation } from './entities/entity-relation.entity';
import { CreateRelationDto } from './dto/create-relation.dto';
import {
  RelationDirection,
  RelationEntityType,
  RelationTypeGroup,
} from '@common/enums/relation.enum';

/**
 * Where each entity type lives, and how a row of that table is pinned to a
 * tenant.
 *
 * This map is the ONLY source of table names in this file. `entityType`
 * arrives from a query string, and interpolating it into SQL with eight tables
 * behind it would be an injection point — the same rule `AssignmentService`
 * follows for its ten junction tables (§4i). The map is keyed by the enum, so
 * a new `RelationEntityType` member that nobody adds a row for is a compile
 * error rather than a runtime `undefined` and a SQL syntax error.
 *
 * `tenantColumn: null` means the table has no `tenantId` — only `tenants`
 * itself, where tenancy is the row's own id. That case is handled explicitly
 * rather than by letting a missing predicate through, because a missing tenant
 * predicate is exactly the §4g bug.
 */
interface EntityTableSpec {
  table: string;
  /** Column holding the owning tenant, or null when the row IS the tenant. */
  tenantColumn: '"tenantId"' | null;
  /** Expression yielding a human label for a node. */
  nameColumn: string;
}

const RELATION_ENTITY_TABLES: Record<RelationEntityType, EntityTableSpec> = {
  [RelationEntityType.DEVICE]: {
    table: 'devices',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.ASSET]: {
    table: 'assets',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.CUSTOMER]: {
    table: 'customers',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.USER]: {
    table: 'users',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.DASHBOARD]: {
    table: 'dashboards',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.TENANT]: {
    table: 'tenants',
    // The row IS the tenant — see resolveEndpoint().
    tenantColumn: null,
    nameColumn: 'name',
  },
  [RelationEntityType.EDGE]: {
    // `EdgeModule` renamed `edge_instances` to `edge_devices`; the entity is
    // `Edge`, the table is not.
    table: 'edge_devices',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
  [RelationEntityType.ALARM]: {
    table: 'alarms',
    tenantColumn: '"tenantId"',
    nameColumn: 'name',
  },
};

/** One resolved endpoint of a relation. */
export interface RelationEndpoint {
  entityType: RelationEntityType;
  entityId: string;
  /** Null only for a row that vanished between two queries. */
  name: string | null;
}

/** A relation with both endpoints' names filled in — what the UI lists. */
export interface RelationInfo {
  id: string;
  fromEntityType: RelationEntityType;
  fromEntityId: string;
  fromName: string | null;
  toEntityType: RelationEntityType;
  toEntityId: string;
  toName: string | null;
  relationType: string;
  relationGroup: string;
  additionalInfo?: Record<string, unknown> | null;
  createdAt?: Date;
}

export interface RelationGraphNode extends RelationEndpoint {
  /** 0 for the root; otherwise the shortest hop count reached in this walk. */
  depth: number;
}

export interface RelationGraphEdge {
  id: string;
  fromEntityType: RelationEntityType;
  fromEntityId: string;
  toEntityType: RelationEntityType;
  toEntityId: string;
  relationType: string;
  relationGroup: string;
  depth: number;
}

export interface RelationGraph {
  root: RelationEndpoint;
  direction: RelationDirection;
  /** The depth actually applied after clamping. */
  maxDepth: number;
  nodes: RelationGraphNode[];
  edges: RelationGraphEdge[];
  /** True when the row cap stopped the walk before it ran out of edges. */
  truncated: boolean;
}

interface GraphRow {
  id: string;
  fromType: RelationEntityType;
  fromId: string;
  toType: RelationEntityType;
  toId: string;
  relationType: string;
  relationGroup: string;
  depth: number | string;
}

/** Ceiling on the recursive walk. Mirrors ALARM_PROPAGATION_MAX_DEPTH (§4b). */
const DEFAULT_MAX_DEPTH = 10;
/** Ceiling on rows returned by one walk, so a dense graph cannot melt a GET. */
const DEFAULT_MAX_EDGES = 2000;

@Injectable()
export class RelationsService {
  private readonly logger = new Logger(RelationsService.name);

  /** Clamp on `maxDepth`; a request may ask for less, never more. */
  private readonly maxDepth = Math.max(
    1,
    Number(process.env.RELATION_GRAPH_MAX_DEPTH ?? DEFAULT_MAX_DEPTH) ||
      DEFAULT_MAX_DEPTH,
  );

  private readonly maxEdges = Math.max(
    1,
    Number(process.env.RELATION_GRAPH_MAX_EDGES ?? DEFAULT_MAX_EDGES) ||
      DEFAULT_MAX_EDGES,
  );

  constructor(
    @InjectRepository(EntityRelation)
    private readonly repo: Repository<EntityRelation>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // ENDPOINT RESOLUTION
  //
  // Nothing in the database constrains `(entityType, entityId)` to an existing
  // row, so this is the only thing standing between the table and a graph of
  // dangling edges.
  // ══════════════════════════════════════════════════════════════════════════

  private specFor(type: RelationEntityType): EntityTableSpec {
    const spec = RELATION_ENTITY_TABLES[type];
    if (!spec) {
      // Unreachable through a validated DTO; reachable from internal callers.
      throw new BadRequestException(`Unsupported entity type "${type}"`);
    }
    return spec;
  }

  /**
   * Prove an endpoint exists and belongs to this tenant, and return its name.
   *
   * Answers **404, not 403**, for a row in another tenant: a 403 confirms the
   * id exists, which turns this into an enumeration oracle across every table
   * the map names (§4g).
   */
  async resolveEndpoint(
    type: RelationEntityType,
    id: string,
    tenantId: string,
  ): Promise<RelationEndpoint> {
    this.assertTenant(tenantId);
    const spec = this.specFor(type);

    // `tenants` has no tenantId column: the only tenant row this caller may
    // name in a relation is their own. Falling back to "no predicate" here is
    // precisely the falsy-tenant-skips-the-filter bug.
    if (spec.tenantColumn === null) {
      if (id !== tenantId) {
        throw new NotFoundException(`${type} ${id} was not found`);
      }
    }

    const predicate =
      spec.tenantColumn === null
        ? 'id = $1'
        : `id = $1 AND ${spec.tenantColumn} = $2`;
    const params = spec.tenantColumn === null ? [id] : [id, tenantId];

    const rows: Array<{ id: string; name: string | null }> =
      await this.repo.manager.query(
        `SELECT id, ${spec.nameColumn} AS name
           FROM "${spec.table}"
          WHERE ${predicate} AND deleted_at IS NULL
          LIMIT 1`,
        params,
      );

    if (!rows.length) {
      throw new NotFoundException(`${type} ${id} was not found`);
    }
    return { entityType: type, entityId: id, name: rows[0].name ?? null };
  }

  /**
   * Batch-resolve names for a set of endpoints: one query per entity type
   * present, not one per node. A 200-node graph would otherwise be 200 round
   * trips, which is how a relations tab becomes the slowest page in the app.
   *
   * Rows outside the tenant simply do not come back, so a name stays null —
   * a traversal must not leak another tenant's entity name even if a crafted
   * row points at one.
   */
  private async resolveNames(
    keys: Array<{ entityType: RelationEntityType; entityId: string }>,
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const byType = new Map<RelationEntityType, Set<string>>();
    for (const key of keys) {
      if (!RELATION_ENTITY_TABLES[key.entityType]) continue;
      const set = byType.get(key.entityType) ?? new Set<string>();
      set.add(key.entityId);
      byType.set(key.entityType, set);
    }

    const names = new Map<string, string | null>();

    for (const [type, ids] of byType) {
      const spec = this.specFor(type);
      const idList = [...ids];

      const predicate =
        spec.tenantColumn === null
          ? 'id = ANY($1::uuid[]) AND id = $2::uuid'
          : `id = ANY($1::uuid[]) AND ${spec.tenantColumn} = $2`;

      const rows: Array<{ id: string; name: string | null }> =
        await this.repo.manager.query(
          `SELECT id, ${spec.nameColumn} AS name
             FROM "${spec.table}"
            WHERE ${predicate} AND deleted_at IS NULL`,
          [idList, tenantId],
        );

      for (const row of rows) {
        names.set(EntityRelation.nodeKey(type, row.id), row.name ?? null);
      }
    }

    return names;
  }

  /**
   * Only SUPER_ADMIN is legitimately tenant-less, and a relation has no
   * meaning without a tenant. Refusing here is what stops a falsy tenantId
   * from reaching a query and leaving it unscoped (§4g).
   */
  private assertTenant(tenantId?: string): asserts tenantId is string {
    if (!tenantId) {
      throw new BadRequestException(
        'Relations belong to a tenant. Sign in as a tenant administrator, or select a tenant first.',
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create one edge.
   *
   * Both endpoints are resolved first: a relation whose `to` points at a
   * deleted or foreign device is worse than no relation, because it renders as
   * a real node with no name and no page.
   */
  async create(
    dto: CreateRelationDto,
    tenantId: string,
    userId?: string,
  ): Promise<RelationInfo> {
    this.assertTenant(tenantId);

    if (
      dto.fromEntityType === dto.toEntityType &&
      dto.fromEntityId === dto.toEntityId
    ) {
      throw new BadRequestException(
        'A relation cannot point an entity at itself',
      );
    }

    const relationGroup = dto.relationGroup ?? RelationTypeGroup.COMMON;

    const [from, to] = await Promise.all([
      this.resolveEndpoint(dto.fromEntityType, dto.fromEntityId, tenantId),
      this.resolveEndpoint(dto.toEntityType, dto.toEntityId, tenantId),
    ]);

    // Checked before the insert so the user gets a sentence instead of a
    // driver-level unique-violation 500. The unique index is still the
    // authority — this check races, the index does not.
    const existing = await this.repo.findOne({
      where: {
        tenantId,
        fromEntityType: dto.fromEntityType,
        fromEntityId: dto.fromEntityId,
        toEntityType: dto.toEntityType,
        toEntityId: dto.toEntityId,
        relationType: dto.relationType,
        deletedAt: IsNull(),
      },
    });
    if (existing) {
      throw new ConflictException('That relation already exists');
    }

    const row = this.repo.create({
      tenantId,
      fromEntityType: dto.fromEntityType,
      fromEntityId: dto.fromEntityId,
      toEntityType: dto.toEntityType,
      toEntityId: dto.toEntityId,
      relationType: dto.relationType,
      relationGroup,
      additionalInfo: dto.additionalInfo ?? null,
      createdBy: userId,
    });

    try {
      const saved = await this.repo.save(row);
      return this.toInfo(saved, from.name, to.name);
    } catch (error) {
      // 23505 is a unique violation — the race the pre-check cannot close.
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('That relation already exists');
      }
      throw error;
    }
  }

  /** Delete one edge named by its 6-tuple (the ThingsBoard-shaped call). */
  async deleteRelation(
    args: {
      fromEntityType: RelationEntityType;
      fromEntityId: string;
      toEntityType: RelationEntityType;
      toEntityId: string;
      relationType: string;
      relationGroup?: RelationTypeGroup;
    },
    tenantId: string,
  ): Promise<{ deleted: number }> {
    this.assertTenant(tenantId);

    const where = {
      tenantId,
      fromEntityType: args.fromEntityType,
      fromEntityId: args.fromEntityId,
      toEntityType: args.toEntityType,
      toEntityId: args.toEntityId,
      relationType: args.relationType,
      deletedAt: IsNull(),
      ...(args.relationGroup ? { relationGroup: args.relationGroup } : {}),
    };

    const row = await this.repo.findOne({ where });
    if (!row) throw new NotFoundException('Relation not found');

    await this.repo.softDelete(row.id);
    return { deleted: 1 };
  }

  /** Delete one edge by its own id — what the UI's row action calls. */
  async deleteById(id: string, tenantId: string): Promise<{ deleted: number }> {
    this.assertTenant(tenantId);

    // Scoped lookup, so an id from another tenant answers 404 rather than
    // being deleted or confirmed to exist.
    const row = await this.repo.findOne({
      where: { id, tenantId, deletedAt: IsNull() },
    });
    if (!row) throw new NotFoundException('Relation not found');

    await this.repo.softDelete(row.id);
    return { deleted: 1 };
  }

  /**
   * Delete every edge touching one entity, in both directions.
   *
   * This is what a device or asset delete should call, otherwise deleting a
   * pump leaves "pump feeds tank" behind pointing at nothing.
   */
  async deleteAllForEntity(
    entityType: RelationEntityType,
    entityId: string,
    tenantId: string,
    relationGroup?: RelationTypeGroup,
  ): Promise<{ deleted: number }> {
    this.assertTenant(tenantId);

    const qb = this.repo
      .createQueryBuilder('relation')
      .where('relation.tenantId = :tenantId', { tenantId })
      .andWhere('relation.deletedAt IS NULL')
      .andWhere(
        `((relation.fromEntityType = :entityType AND relation.fromEntityId = :entityId)
           OR (relation.toEntityType = :entityType AND relation.toEntityId = :entityId))`,
        { entityType, entityId },
      );

    if (relationGroup) {
      qb.andWhere('relation.relationGroup = :relationGroup', { relationGroup });
    }

    const rows = await qb.getMany();
    if (!rows.length) return { deleted: 0 };

    await this.repo.softDelete(rows.map((row) => row.id));
    return { deleted: rows.length };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  // ══════════════════════════════════════════════════════════════════════════

  /** Outbound edges: what this entity relates TO. */
  findByFrom(
    entityType: RelationEntityType,
    entityId: string,
    tenantId: string,
    filters: { relationType?: string; relationGroup?: RelationTypeGroup } = {},
  ): Promise<RelationInfo[]> {
    return this.findDirectional('from', entityType, entityId, tenantId, filters);
  }

  /** Inbound edges: what relates TO this entity. */
  findByTo(
    entityType: RelationEntityType,
    entityId: string,
    tenantId: string,
    filters: { relationType?: string; relationGroup?: RelationTypeGroup } = {},
  ): Promise<RelationInfo[]> {
    return this.findDirectional('to', entityType, entityId, tenantId, filters);
  }

  private async findDirectional(
    side: 'from' | 'to',
    entityType: RelationEntityType,
    entityId: string,
    tenantId: string,
    filters: { relationType?: string; relationGroup?: RelationTypeGroup },
  ): Promise<RelationInfo[]> {
    this.assertTenant(tenantId);

    const typeColumn = side === 'from' ? 'fromEntityType' : 'toEntityType';
    const idColumn = side === 'from' ? 'fromEntityId' : 'toEntityId';

    const qb = this.repo
      .createQueryBuilder('relation')
      .where('relation.tenantId = :tenantId', { tenantId })
      .andWhere(`relation.${typeColumn} = :entityType`, { entityType })
      .andWhere(`relation.${idColumn} = :entityId`, { entityId })
      .orderBy('relation.relationType', 'ASC')
      .addOrderBy('relation.createdAt', 'ASC');

    if (filters.relationType) {
      qb.andWhere('relation.relationType = :relationType', {
        relationType: filters.relationType,
      });
    }
    if (filters.relationGroup) {
      qb.andWhere('relation.relationGroup = :relationGroup', {
        relationGroup: filters.relationGroup,
      });
    }

    const rows = await qb.getMany();
    return this.withNames(rows, tenantId);
  }

  /** Every edge of one relation type in the tenant. */
  async findByType(
    relationType: string,
    tenantId: string,
    options: { relationGroup?: RelationTypeGroup; limit?: number } = {},
  ): Promise<RelationInfo[]> {
    this.assertTenant(tenantId);

    const qb = this.repo
      .createQueryBuilder('relation')
      .where('relation.tenantId = :tenantId', { tenantId })
      .andWhere('relation.relationType = :relationType', { relationType })
      .orderBy('relation.createdAt', 'DESC')
      .take(Math.min(options.limit ?? 200, 1000));

    if (options.relationGroup) {
      qb.andWhere('relation.relationGroup = :relationGroup', {
        relationGroup: options.relationGroup,
      });
    }

    const rows = await qb.getMany();
    return this.withNames(rows, tenantId);
  }

  /** Both directions in one call — what the Relations tab renders. */
  async findForEntity(
    entityType: RelationEntityType,
    entityId: string,
    tenantId: string,
    filters: { relationType?: string; relationGroup?: RelationTypeGroup } = {},
  ): Promise<{ outbound: RelationInfo[]; inbound: RelationInfo[] }> {
    const [outbound, inbound] = await Promise.all([
      this.findByFrom(entityType, entityId, tenantId, filters),
      this.findByTo(entityType, entityId, tenantId, filters),
    ]);
    return { outbound, inbound };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GRAPH TRAVERSAL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Walk the graph from one root and return nodes + edges.
   *
   * A relation graph is a general digraph — unlike `assets.parentAssetId`,
   * nothing prevents `A feeds B feeds C feeds A`, and a user drawing a loop is
   * a plausible mistake, not an attack. An unguarded recursive CTE over a
   * cyclic graph does not return. So, following the alarm-propagation pattern
   * in §4b, this has **both** guards and they are independent:
   *
   *  1. **Cycle guard** — `path` carries every node key visited on the way to
   *     the current row, and the recursive term refuses a next hop whose node
   *     key is already in it (`NOT … = ANY(path)`). That terminates any cycle
   *     at the point it would close, without forbidding the diamond case where
   *     two different paths legitimately reach the same node.
   *  2. **Depth bound** — `depth + 1 <= $4`, with `$4` clamped server-side to
   *     `RELATION_GRAPH_MAX_DEPTH` (default 10). The cycle guard alone bounds
   *     the walk only by the size of the tenant's graph; a 50,000-edge tenant
   *     would still return everything reachable.
   *  3. A **row cap** (`LIMIT`) on top of both, because breadth is unbounded
   *     even at depth 3 — and a `truncated` flag, so the UI says the picture
   *     is partial rather than quietly drawing a wrong one.
   *
   * Belt and braces: the rows are de-duplicated in TypeScript as well, keyed
   * on node key and relation id. The CTE already does it via `path`, but a
   * future rewrite of the SQL cannot then reintroduce a loop into the response.
   */
  async buildGraph(
    args: {
      rootType: RelationEntityType;
      rootId: string;
      direction?: RelationDirection;
      maxDepth?: number;
      relationType?: string;
      relationGroup?: RelationTypeGroup;
    },
    tenantId: string,
  ): Promise<RelationGraph> {
    this.assertTenant(tenantId);

    const direction = args.direction ?? RelationDirection.FROM;
    const depth = Math.min(
      Math.max(1, Math.trunc(args.maxDepth ?? 5)),
      this.maxDepth,
    );

    // The root is resolved first: it proves the entity exists and is this
    // tenant's, gives the graph a named centre, and means a bad root is a 404
    // instead of an empty graph that looks like "no relations".
    const root = await this.resolveEndpoint(args.rootType, args.rootId, tenantId);

    const sql =
      direction === RelationDirection.FROM
        ? this.graphSqlDownstream()
        : this.graphSqlUpstream();

    const rows: GraphRow[] = await this.repo.manager.query(sql, [
      tenantId,
      args.rootType,
      args.rootId,
      depth,
      args.relationType ?? null,
      args.relationGroup ?? null,
      // One more than the cap, so `truncated` can be reported without a
      // second counting query.
      this.maxEdges + 1,
    ]);

    const truncated = rows.length > this.maxEdges;
    const kept = truncated ? rows.slice(0, this.maxEdges) : rows;

    const nodeDepths = new Map<string, RelationGraphNode>();
    const rootKey = EntityRelation.nodeKey(root.entityType, root.entityId);
    nodeDepths.set(rootKey, { ...root, depth: 0 });

    const edges: RelationGraphEdge[] = [];
    const seenEdges = new Set<string>();

    for (const row of kept) {
      const rowDepth = Number(row.depth);

      if (!seenEdges.has(row.id)) {
        seenEdges.add(row.id);
        edges.push({
          id: row.id,
          fromEntityType: row.fromType,
          fromEntityId: row.fromId,
          toEntityType: row.toType,
          toEntityId: row.toId,
          relationType: row.relationType,
          relationGroup: row.relationGroup,
          depth: rowDepth,
        });
      }

      // The node the hop reached. Keep the SHALLOWEST depth seen: two paths
      // can arrive at the same node and the useful answer is "how far is this
      // from the root", not "how far was it on the last path tried".
      const reached =
        direction === RelationDirection.FROM
          ? { entityType: row.toType, entityId: row.toId }
          : { entityType: row.fromType, entityId: row.fromId };
      const reachedKey = EntityRelation.nodeKey(
        reached.entityType,
        reached.entityId,
      );
      const current = nodeDepths.get(reachedKey);
      if (!current || current.depth > rowDepth) {
        nodeDepths.set(reachedKey, {
          entityType: reached.entityType,
          entityId: reached.entityId,
          name: current?.name ?? null,
          depth: Math.min(current?.depth ?? rowDepth, rowDepth),
        });
      }

      // The other end can also be a node nobody else introduces — the root's
      // own counterpart at depth 1, or a node reached by an edge whose
      // opposite end was pruned by the cap.
      const other =
        direction === RelationDirection.FROM
          ? { entityType: row.fromType, entityId: row.fromId }
          : { entityType: row.toType, entityId: row.toId };
      const otherKey = EntityRelation.nodeKey(other.entityType, other.entityId);
      if (!nodeDepths.has(otherKey)) {
        nodeDepths.set(otherKey, {
          entityType: other.entityType,
          entityId: other.entityId,
          name: null,
          depth: Math.max(0, rowDepth - 1),
        });
      }
    }

    const names = await this.resolveNames([...nodeDepths.values()], tenantId);
    const nodes = [...nodeDepths.entries()]
      .map(([key, node]) => ({ ...node, name: names.get(key) ?? null }))
      .sort((a, b) => a.depth - b.depth || a.entityType.localeCompare(b.entityType));

    if (truncated) {
      this.logger.warn(
        `Relation graph from ${rootKey} hit the ${this.maxEdges}-edge cap at depth ${depth}`,
      );
    }

    return { root, direction, maxDepth: depth, nodes, edges, truncated };
  }

  /**
   * `direction=FROM` — follow edges out of the current node.
   *
   * Parameters: $1 tenantId · $2 rootType · $3 rootId · $4 maxDepth ·
   * $5 relationType|null · $6 relationGroup|null · $7 row cap.
   *
   * The `tenantId` predicate is repeated in the recursive term on purpose:
   * without it the walk would leave the tenant at the first hop, because the
   * join is on a (type, id) pair that carries no tenancy of its own.
   */
  private graphSqlDownstream(): string {
    return `
      WITH RECURSIVE walk AS (
        SELECT r.id,
               r."fromEntityType" AS "fromType",
               r."fromEntityId"   AS "fromId",
               r."toEntityType"   AS "toType",
               r."toEntityId"     AS "toId",
               r."relationType",
               r."relationGroup",
               1 AS depth,
               ARRAY[
                 r."fromEntityType" || ':' || r."fromEntityId"::text,
                 r."toEntityType"   || ':' || r."toEntityId"::text
               ] AS path
          FROM entity_relations r
         WHERE r."tenantId" = $1::uuid
           AND r.deleted_at IS NULL
           AND r."fromEntityType" = $2
           AND r."fromEntityId" = $3::uuid
           AND ($5::varchar IS NULL OR r."relationType" = $5)
           AND ($6::varchar IS NULL OR r."relationGroup" = $6)
        UNION ALL
        SELECT n.id,
               n."fromEntityType",
               n."fromEntityId",
               n."toEntityType",
               n."toEntityId",
               n."relationType",
               n."relationGroup",
               w.depth + 1,
               w.path || (n."toEntityType" || ':' || n."toEntityId"::text)
          FROM entity_relations n
          JOIN walk w
            ON n."fromEntityType" = w."toType"
           AND n."fromEntityId" = w."toId"
         WHERE n."tenantId" = $1::uuid
           AND n.deleted_at IS NULL
           AND w.depth + 1 <= $4::int
           AND NOT (n."toEntityType" || ':' || n."toEntityId"::text) = ANY(w.path)
           AND ($5::varchar IS NULL OR n."relationType" = $5)
           AND ($6::varchar IS NULL OR n."relationGroup" = $6)
      )
      SELECT id, "fromType", "fromId", "toType", "toId",
             "relationType", "relationGroup", depth
        FROM walk
       ORDER BY depth ASC, id ASC
       LIMIT $7::int
    `;
  }

  /** `direction=TO` — the same walk with the join reversed. */
  private graphSqlUpstream(): string {
    return `
      WITH RECURSIVE walk AS (
        SELECT r.id,
               r."fromEntityType" AS "fromType",
               r."fromEntityId"   AS "fromId",
               r."toEntityType"   AS "toType",
               r."toEntityId"     AS "toId",
               r."relationType",
               r."relationGroup",
               1 AS depth,
               ARRAY[
                 r."toEntityType"   || ':' || r."toEntityId"::text,
                 r."fromEntityType" || ':' || r."fromEntityId"::text
               ] AS path
          FROM entity_relations r
         WHERE r."tenantId" = $1::uuid
           AND r.deleted_at IS NULL
           AND r."toEntityType" = $2
           AND r."toEntityId" = $3::uuid
           AND ($5::varchar IS NULL OR r."relationType" = $5)
           AND ($6::varchar IS NULL OR r."relationGroup" = $6)
        UNION ALL
        SELECT n.id,
               n."fromEntityType",
               n."fromEntityId",
               n."toEntityType",
               n."toEntityId",
               n."relationType",
               n."relationGroup",
               w.depth + 1,
               w.path || (n."fromEntityType" || ':' || n."fromEntityId"::text)
          FROM entity_relations n
          JOIN walk w
            ON n."toEntityType" = w."fromType"
           AND n."toEntityId" = w."fromId"
         WHERE n."tenantId" = $1::uuid
           AND n.deleted_at IS NULL
           AND w.depth + 1 <= $4::int
           AND NOT (n."fromEntityType" || ':' || n."fromEntityId"::text) = ANY(w.path)
           AND ($5::varchar IS NULL OR n."relationType" = $5)
           AND ($6::varchar IS NULL OR n."relationGroup" = $6)
      )
      SELECT id, "fromType", "fromId", "toType", "toId",
             "relationType", "relationGroup", depth
        FROM walk
       ORDER BY depth ASC, id ASC
       LIMIT $7::int
    `;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SHAPING
  // ══════════════════════════════════════════════════════════════════════════

  private toInfo(
    row: EntityRelation,
    fromName: string | null,
    toName: string | null,
  ): RelationInfo {
    return {
      id: row.id,
      fromEntityType: row.fromEntityType,
      fromEntityId: row.fromEntityId,
      fromName,
      toEntityType: row.toEntityType,
      toEntityId: row.toEntityId,
      toName,
      relationType: row.relationType,
      relationGroup: row.relationGroup,
      additionalInfo: row.additionalInfo ?? null,
      createdAt: row.createdAt,
    };
  }

  /** Fill in both endpoints' names for a page of rows, in two queries max. */
  private async withNames(
    rows: EntityRelation[],
    tenantId: string,
  ): Promise<RelationInfo[]> {
    if (!rows.length) return [];

    const keys: Array<{ entityType: RelationEntityType; entityId: string }> = [];
    for (const row of rows) {
      keys.push({ entityType: row.fromEntityType, entityId: row.fromEntityId });
      keys.push({ entityType: row.toEntityType, entityId: row.toEntityId });
    }

    const names = await this.resolveNames(keys, tenantId);
    return rows.map((row) =>
      this.toInfo(
        row,
        names.get(row.fromKey) ?? null,
        names.get(row.toKey) ?? null,
      ),
    );
  }
}
