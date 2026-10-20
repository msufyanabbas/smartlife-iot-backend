// src/common/enums/relation.enum.ts
//
// The entity-relation vocabulary.
//
// `AuditEntityType` already names most of these, and reusing it was the first
// thing tried. It does not fit, for two reasons that both bite at runtime
// rather than at compile time:
//
//   1. It has no EDGE member, and an edge appliance is one of the things a
//      relation graph most obviously needs to hang devices off.
//   2. Its values are lower_snake_case (`device_profile`, `rule_chain`) and it
//      carries a dozen members that are not addressable rows at all
//      (`telemetry`, `settings`, `file`). A relation's endpoint has to be
//      resolvable to exactly one table so the row can be proved to exist and
//      to belong to the caller's tenant; `telemetry` is not.
//
// So this is its own, deliberately small enum: one member per table the
// resolver in `RelationsService` knows how to look up. Adding a member without
// adding its entry to `RELATION_ENTITY_TABLES` is a compile error, which is the
// point — a type with no table would silently create dangling relations.
//
// Values are UPPERCASE to match ThingsBoard's `EntityType`, so a relation
// exported from this platform reads the same as one exported from there.
export enum RelationEntityType {
  DEVICE = 'DEVICE',
  ASSET = 'ASSET',
  CUSTOMER = 'CUSTOMER',
  USER = 'USER',
  DASHBOARD = 'DASHBOARD',
  TENANT = 'TENANT',
  EDGE = 'EDGE',
  ALARM = 'ALARM',
}

/**
 * Relation groups partition the graph so one subsystem's edges do not show up
 * in another's traversal. `COMMON` is the user-facing one and the default;
 * the rest exist so that machine-written edges (a dashboard's state chain, an
 * edge appliance's sync set) can be swept without touching what a user drew.
 *
 * Stored as varchar, not a PG enum — §4f's lesson: a new TypeScript member
 * passes `@IsEnum` and then the INSERT fails with
 * `invalid input value for enum`.
 */
export enum RelationTypeGroup {
  COMMON = 'COMMON',
  ALARM = 'ALARM',
  DASHBOARD = 'DASHBOARD',
  RULE_CHAIN = 'RULE_CHAIN',
  RULE_NODE = 'RULE_NODE',
  EDGE = 'EDGE',
}

/** Which way a traversal walks from the root. */
export enum RelationDirection {
  /** Follow edges whose `from` is the current node — "what does this feed?" */
  FROM = 'FROM',
  /** Follow edges whose `to` is the current node — "what feeds this?" */
  TO = 'TO',
}

/**
 * The relation types the UI offers. `relationType` is a free varchar on
 * purpose — a tenant modelling a chilled-water loop should not need a
 * migration to write `Chills` — so this list is a palette, not a constraint.
 */
export const COMMON_RELATION_TYPES = [
  'Contains',
  'Manages',
  'Feeds',
  'Powers',
  'Monitors',
  'Controls',
  'Uses',
] as const;
