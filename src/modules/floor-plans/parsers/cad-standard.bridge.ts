import { CadStandardsService } from '@modules/cad-standards/cad-standards.service';
import type { CadRole } from '@modules/cad-standards/cad-standard.catalogue';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Standard → parser bridge
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `DxfFloorPlanParser` is a static class with no constructor and no DI — it
 * is called from a service, from a script and from tests, so it cannot take
 * `CadStandardsService` as a dependency without rewriting every call site.
 *
 * `CadStandardsService` is a pure function over a constant table: no
 * repositories, no config, no other services. Instantiating one directly
 * here is therefore safe and does not duplicate state — there is no state.
 * The alternative, importing the catalogue arrays and re-implementing the
 * matching, is how the two copies drift apart.
 */
const service = new CadStandardsService();

/** The parser's own category buckets, keyed by the standard's role. */
export type ParserBucket = 'wall' | 'door' | 'window' | 'column' | 'stair' | 'room' | null;

/**
 * Which of the parser's regex arrays a standard role corresponds to.
 *
 * Roles missing from this map are real, classified geometry that the parser
 * has no bucket for (slabs, railings, lifts, devices). They deliberately
 * resolve to `null`, which means "the standard recognised it and it is NOT
 * one of your categories" — the parser must then not claim it as a wall.
 */
const ROLE_TO_BUCKET: Partial<Record<CadRole, ParserBucket>> = {
  wall: 'wall',
  partition: 'wall',
  curtain_wall: 'wall',
  door: 'door',
  window: 'window',
  column: 'column',
  stair: 'stair',
  room_label: 'room',
};

export interface ParserClassification {
  bucket: ParserBucket;
  role: CadRole;
  /** The regex array this layer belongs to, or null for none of them. */
  patternSet: RegExp[] | null;
  buildable: boolean;
}

/**
 * Registered by the parser at module load so the bridge can compare against
 * the very arrays `matchesLayer` is called with, rather than guessing which
 * category the caller meant.
 */
const registry = new Map<ParserBucket, RegExp[]>();

export function registerPatternSets(sets: {
  wall: RegExp[];
  door: RegExp[];
  window: RegExp[];
  column: RegExp[];
  stair: RegExp[];
  room: RegExp[];
}): void {
  registry.set('wall', sets.wall);
  registry.set('door', sets.door);
  registry.set('window', sets.window);
  registry.set('column', sets.column);
  registry.set('stair', sets.stair);
  registry.set('room', sets.room);
}

export const CAD_STANDARD = {
  service,

  /**
   * Returns null when the standard does not recognise the layer, so the
   * caller falls back to its own regexes. Returns a classification when it
   * does — including one whose `patternSet` is null, meaning "recognised,
   * but none of your buckets".
   */
  classifyForParser(layerName: string): ParserClassification | null {
    const c = service.classify(layerName);
    // `unknown` basis means the standard had nothing to say. Everything
    // else is an answer, including an ignore.
    if (c.basis === 'unknown') return null;

    const bucket = ROLE_TO_BUCKET[c.role] ?? null;
    return {
      bucket,
      role: c.role,
      patternSet: bucket ? (registry.get(bucket) ?? null) : null,
      buildable: c.solid !== 'ignore',
    };
  },
};
