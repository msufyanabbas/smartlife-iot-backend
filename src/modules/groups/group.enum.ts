// src/modules/groups/group.enum.ts
//
// Kept in the module rather than in the shared `index.enum.ts` barrel: several
// agents edit that file concurrently and nothing outside GroupsModule needs
// these names.
//
// Stored as `character varying`, not a PostgreSQL enum. A PG enum column needs
// `ALTER TYPE ... ADD VALUE` before a new TypeScript member can be inserted —
// `@IsEnum` accepts it and the INSERT then fails (CLAUDE.md §4e). Grouping a
// new entity kind should not need a migration, only a row in the table below.

/** The kinds of entity a group can hold. A group holds exactly one kind. */
export enum GroupEntityType {
  DEVICE = 'DEVICE',
  ASSET = 'ASSET',
  CUSTOMER = 'CUSTOMER',
  USER = 'USER',
}

/**
 * Where a member id is validated, per entity type.
 *
 * `table` and `tenantColumn` are used to build the one parameterised
 * `SELECT id FROM <table> WHERE id = ANY($1) AND "<tenantColumn>" = $2` that
 * `GroupsService.verifyMembers()` runs before any membership row is written.
 * Table and column names come from THIS table and never from a request, so
 * nothing user-supplied is ever interpolated into the SQL.
 */
export const GROUP_MEMBER_SOURCES: Record<
  GroupEntityType,
  { table: string; tenantColumn: string; labelColumn: string }
> = {
  [GroupEntityType.DEVICE]: {
    table: 'devices',
    tenantColumn: 'tenantId',
    labelColumn: 'name',
  },
  [GroupEntityType.ASSET]: {
    table: 'assets',
    tenantColumn: 'tenantId',
    labelColumn: 'name',
  },
  [GroupEntityType.CUSTOMER]: {
    table: 'customers',
    tenantColumn: 'tenantId',
    labelColumn: 'name',
  },
  [GroupEntityType.USER]: {
    table: 'users',
    tenantColumn: 'tenantId',
    labelColumn: 'name',
  },
};
