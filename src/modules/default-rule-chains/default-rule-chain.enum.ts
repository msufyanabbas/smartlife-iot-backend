// src/modules/default-rule-chains/default-rule-chain.enum.ts
//
// Declared in the module rather than in the shared `index.enum.ts` barrel —
// several agents edit that file at once and nothing outside this module and the
// rule-engine consumer needs these names.
//
// Stored as `character varying`, never as a PostgreSQL enum: a PG enum column
// needs `ALTER TYPE ... ADD VALUE` before a new TypeScript member can be
// inserted at all, and `@IsEnum` will happily accept a value the INSERT then
// rejects (CLAUDE.md §4e). The set of originator and message types this
// platform routes is still growing.

/** The wildcard both match columns use for "any". */
export const DEFAULT_RULE_CHAIN_ANY = '*';

/**
 * What kind of thing produced the message.
 *
 * `RuleEngineConsumer` takes this from `payload.entityType`, defaulting to
 * `DEVICE` — so DEVICE is the only value real telemetry traffic carries today.
 * The rest exist because the frontend's `default-rule-chains.api.ts` ships
 * DEVICE / ASSET / EDGE, and because an originator type is the obvious axis to
 * route on once other producers publish to `rules.input`.
 */
export enum DefaultRuleChainOriginatorType {
  ANY = '*',
  DEVICE = 'DEVICE',
  ASSET = 'ASSET',
  EDGE = 'EDGE',
  CUSTOMER = 'CUSTOMER',
  TENANT = 'TENANT',
  ALARM = 'ALARM',
  ENTITY_VIEW = 'ENTITY_VIEW',
}

/**
 * Common message types, offered as suggestions by
 * `GET /default-rule-chains/message-types`.
 *
 * The column is free text: the consumer passes `payload.eventType` through
 * verbatim, so an integration emitting its own event name must be routable
 * without a migration. Validation is "non-empty, no whitespace", not
 * membership of this list.
 */
export const DEFAULT_RULE_CHAIN_MESSAGE_TYPES = [
  'TELEMETRY',
  'ATTRIBUTES',
  'ATTRIBUTES_UPDATED',
  'ATTRIBUTES_DELETED',
  'ALARM',
  'ALARM_ACK',
  'ALARM_CLEAR',
  'RPC_REQUEST',
  'RPC_RESPONSE',
  'ENTITY_CREATED',
  'ENTITY_UPDATED',
  'ENTITY_DELETED',
  'CONNECT_EVENT',
  'DISCONNECT_EVENT',
  'ACTIVITY_EVENT',
  'INACTIVITY_EVENT',
] as const;

/** Which column produced the match, reported by the resolver. */
export type DefaultRuleChainMatchKind =
  | 'deviceProfile'
  | 'messageType'
  | 'originatorType'
  | 'wildcard'
  | 'rootFallback'
  | 'none';
