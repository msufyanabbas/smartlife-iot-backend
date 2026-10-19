import { CadStandardsService } from '@modules/cad-standards/cad-standards.service';
import type { SolidBehaviour } from '@modules/cad-standards/cad-standard.catalogue';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Apply the drawing standard before anything is extruded
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the step that makes "if the standard says it is empty space, the 3D
 * model shows empty space" literally true.
 *
 * A CAD plan is full of geometry that is DRAWN but is not THERE:
 *
 *   • G-GRID         setting-out lines spanning the whole plan
 *   • G-ANNO-DIMS    dimension strings and their witness lines
 *   • A-AREA-IDEN    room tags
 *   • A-WALL-PATT    the hatch INSIDE a wall drawn on another layer
 *   • A-WALL-DEMO    a wall that is being torn out
 *   • A-FLOR-STRS-ABOV / S-BEAM / A-CLNG    above the 1200 cut plane
 *   • Defpoints      never plots at all
 *
 * Every one of those is a closed polyline or a line segment, which is to say
 * every one of them extrudes perfectly happily into a wall. The result is a
 * model with a grid of walls across every room, the word "OFFICE" standing up
 * in 3D, and the demolished partition still in place.
 *
 * So the geometry is filtered by LAYER before the builder sees it, and every
 * drop is recorded with the standard's own reason, so the operator can see
 * what happened instead of wondering why their model looks wrong.
 */

const standards = new CadStandardsService();

export interface StandardFilterOptions {
  /** Off means build everything, as the importer did before. */
  enforce: boolean;
  /**
   * Keep geometry on layers the standard does not recognise.
   *
   * Default false: an unknown layer is excluded rather than guessed at,
   * because a wrong solid is harder to notice than a missing one. Operators
   * importing non-conformant drawings can turn it on and read the compliance
   * report to see what they are getting.
   */
  keepUnrecognised: boolean;
}

export const DEFAULT_STANDARD_FILTER: StandardFilterOptions = {
  enforce: true,
  keepUnrecognised: false,
};

export interface DroppedGeometry {
  category: string;
  layer: string;
  count: number;
  reason: string;
  role: string;
}

export interface StandardFilterResult<T> {
  geometry: T;
  dropped: DroppedGeometry[];
  /** Layers whose geometry became an opening rather than a solid. */
  voidLayers: string[];
  warnings: string[];
}

/** Categories in SourceGeometry whose items carry a `layer`. */
const CATEGORIES = [
  'walls',
  'rooms',
  'doors',
  'windows',
  'columns',
  'stairs',
  'furniture',
] as const;

/**
 * A category's own meaning wins over the layer's default behaviour.
 *
 * The parser has already decided that something is a DOOR. The standard says
 * `A-DOOR` is a `void`, and a void is correct — but it must not be dropped
 * here, because the mesh factory is what turns it into an opening. Dropping
 * voids in this pass would delete every door and window instead of cutting
 * them.
 */
const CATEGORY_ACCEPTS: Record<string, SolidBehaviour[]> = {
  walls: ['build'],
  rooms: ['build', 'ignore'], // room outlines drive the floor slab, see below
  doors: ['build', 'void'],
  windows: ['build', 'void'],
  columns: ['build'],
  stairs: ['build'],
  furniture: ['build'],
};

export function applyCadStandard<T extends Record<string, any>>(
  source: T,
  options: StandardFilterOptions = DEFAULT_STANDARD_FILTER,
): StandardFilterResult<T> {
  if (!options.enforce) {
    return { geometry: source, dropped: [], voidLayers: [], warnings: [] };
  }

  const dropped = new Map<string, DroppedGeometry>();
  const voidLayers = new Set<string>();
  const warnings: string[] = [];
  const out: Record<string, any> = { ...source };

  for (const category of CATEGORIES) {
    const items = source[category];
    if (!Array.isArray(items) || items.length === 0) continue;

    const accepts = CATEGORY_ACCEPTS[category] ?? ['build'];
    const kept: any[] = [];

    for (const item of items) {
      const layer = String(item?.layer ?? item?.layerName ?? '').trim();

      // No layer at all: geometry the parser synthesised, or a drawing that
      // never set one. There is nothing to judge it by, so it is kept —
      // silently dropping unlabelled geometry would be worse.
      if (!layer) {
        kept.push(item);
        continue;
      }

      const c = standards.classify(layer, item?.linetype);

      if (c.basis === 'unknown' && options.keepUnrecognised) {
        kept.push(item);
        continue;
      }

      if (accepts.includes(c.solid)) {
        if (c.solid === 'void') voidLayers.add(layer);
        kept.push(item);
        continue;
      }

      const key = `${category}|${layer}`;
      const existing = dropped.get(key);
      if (existing) existing.count++;
      else {
        dropped.set(key, {
          category,
          layer,
          count: 1,
          role: c.role,
          reason:
            c.ignoreReason ??
            `Classified as ${c.role} (${c.solid}), which a ${category.slice(0, -1)} cannot be.`,
        });
      }
    }

    out[category] = kept;
  }

  // ── Sanity checks on the RESULT, not the input ─────────────────────────
  //
  // Filtering correctly and producing nothing is still a bad outcome, and
  // the operator should hear it from the importer rather than from an empty
  // viewer.
  const wallsBefore = Array.isArray(source.walls) ? source.walls.length : 0;
  const wallsAfter = Array.isArray(out.walls) ? out.walls.length : 0;
  if (wallsBefore > 0 && wallsAfter === 0) {
    warnings.push(
      `All ${wallsBefore} wall candidates were excluded by the drawing ` +
        `standard, so the model will have no walls. The most likely cause is ` +
        `that they are on a layer the standard does not recognise — see the ` +
        `compliance report for the layer names and their suggested ` +
        `replacements.`,
    );
  } else if (wallsBefore > 0 && wallsAfter < wallsBefore * 0.5) {
    warnings.push(
      `${wallsBefore - wallsAfter} of ${wallsBefore} wall candidates were ` +
        `excluded. That is most of them, which usually means a layer naming ` +
        `mismatch rather than a drawing full of demolition.`,
    );
  }

  const list = [...dropped.values()].sort((a, b) => b.count - a.count);
  return { geometry: out as T, dropped: list, voidLayers: [...voidLayers], warnings };
}

/** One-line summaries for the build result's `warnings`. */
export function describeDropped(dropped: DroppedGeometry[]): string[] {
  return dropped.map(
    (d) =>
      `Excluded ${d.count} ${d.category} on ${d.layer} (${d.role}): ${d.reason}`,
  );
}
