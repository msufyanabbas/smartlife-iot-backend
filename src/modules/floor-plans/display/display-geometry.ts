/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Display geometry — what the 3D VIEWER should be given
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defect this exists to fix is architectural, and it is the reason the
 * client reported that the standard and the filters "don't work" even though
 * both were implemented and tested.
 *
 * There were two consumers of a parsed drawing, and only one of them applied
 * the drawing standard:
 *
 *   DxfFloorPlanParser.parse()
 *          │
 *          ├──▶ FloorPlanMeshFactory.build()   applies the standard, pairs
 *          │      (the EXPORT path)            nothing, cuts openings, emits
 *          │                                   triangles → .glb / .obj
 *          │
 *          └──▶ GET /floor-plans/:id → parsedGeometry
 *                 (the VIEWER path)            NO FILTERING AT ALL
 *
 * The viewer builds its own geometry client-side from `parsedGeometry`, and the
 * parser is deliberately permissive — it hands over every line as a wall
 * CANDIDATE and lets the consumer decide. Measured on the client's own drawing
 * library: **790 of 1211 "walls" are on layers the standard says are not
 * built.** The viewer extruded all 1211. So the model on screen contained the
 * sheet title block, the wall hatching, the section views, the dimension
 * strings, the grid lines running the full width of the plan, and the letter
 * outlines of the general notes standing up as solid objects.
 *
 * Nothing was wrong with the standard. It was simply not on the path that
 * draws the picture.
 *
 * This module is that path. It takes parser output and returns geometry that
 * is ready to draw, with four transformations applied in order:
 *
 *   1. **The standard**, via the same `applyCadStandard` the export path uses.
 *      One implementation, two consumers — rather than a second copy that
 *      drifts, which is the mistake §4g documents five times over.
 *   2. **Wall pairing**, so the two drawn faces of a wall become one wall of
 *      the measured thickness instead of two thin walls with a slot between
 *      them. See `wall-pairing.ts`.
 *   3. **Opening splitting**, so a wall arrives already broken into the solid
 *      pieces around its doors and windows. The viewer draws plain boxes; the
 *      hole is real because the box is not there. No CSG in the browser.
 *   4. **X-mark voids**, the client's "that space is empty" convention. See
 *      `x-void.ts`.
 *
 * Every length in the output is in METRES. The parser already scales to
 * metres; this module does not rescale, and a consumer must not apply a
 * drawing-unit factor to anything here. That matters because the viewer's
 * thickness bug was exactly this — it multiplied a value already in metres by
 * a canvas pixel scale and then clamped the result.
 *
 * The output also carries what was REMOVED and why (`excluded`), so a screen
 * can answer "where did my walls go?" with the standard's own reason instead
 * of leaving the operator to guess.
 */
import {
  applyCadStandard,
  describeDropped,
  DEFAULT_STANDARD_FILTER,
  type DroppedGeometry,
  type StandardFilterOptions,
} from '../mesh/cad-standard.filter';
import { CadStandardsService } from '@modules/cad-standards/cad-standards.service';
import {
  pairWallFaces,
  DEFAULT_PAIRING,
  type PairedWall,
  type PairingOptions,
} from './wall-pairing';
import {
  detectXVoids,
  suppressInsideVoids,
  DEFAULT_X_VOID,
  type DetectedVoid,
  type XVoidOptions,
} from './x-void';

const standards = new CadStandardsService();

export interface Vec2 {
  x: number;
  y: number;
}

/** A solid piece of wall. Already excludes its openings. */
export interface DisplayWallSegment {
  id: string;
  /** Parent wall, so the viewer can group segments of one wall. */
  wallId: string;
  start: Vec2;
  end: Vec2;
  /** Metres. */
  thickness: number;
  /** Metres — the bottom of this piece above the floor. */
  bottom: number;
  /** Metres — the top of this piece above the floor. */
  top: number;
  layer: string;
  thicknessSource: PairedWall['thicknessSource'];
}

export interface DisplayOpening {
  id: string;
  kind: 'door' | 'window';
  /** Centre of the opening, in plan. Metres. */
  position: Vec2;
  /** Metres, along the wall. */
  width: number;
  /** Metres. */
  height: number;
  /** Metres above the floor. 0 for a door. */
  sill: number;
  /** DEGREES, measured from the +x axis, taken from the host wall. */
  rotation: number;
  /** Metres — the host wall's thickness, so a frame can be drawn to fit. */
  wallThickness: number;
  /** The wall this opening was cut into, or null when it matched none. */
  wallId: string | null;
  layer: string;
}

export interface DisplayGeometry {
  walls: DisplayWallSegment[];
  openings: DisplayOpening[];
  rooms: Array<{
    id: string;
    vertices: Vec2[];
    center: Vec2;
    area: number;
    name?: string;
    layer: string;
  }>;
  columns: any[];
  stairs: any[];
  devices: any[];
  /** Loose contents — desks, fittings. Suppressed inside a crossed-out space. */
  furniture: any[];
  /** Crossed-out regions: the floor stays, nothing is placed inside. */
  voids: DetectedVoid[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  /** Metres. The storey height the drawing implies, or the default. */
  wallHeight: number;
  units: 'm';
  stats: {
    wallCandidates: number;
    wallsAfterStandard: number;
    wallsPaired: number;
    wallsUnpaired: number;
    segments: number;
    openingsMatched: number;
    openingsUnmatched: number;
    voids: number;
    devicesSuppressedByVoid: number;
    furnitureSuppressedByVoid: number;
  };
  /** What the standard removed, with its reason. */
  excluded: DroppedGeometry[];
  warnings: string[];
}

export interface DisplayGeometryOptions {
  standard: StandardFilterOptions;
  pairing: Partial<PairingOptions>;
  xVoid: Partial<XVoidOptions>;
  /** Metres, when the drawing does not say. */
  wallHeight: number;
  doorHeight: number;
  windowSill: number;
  windowHeight: number;
  /** Off returns unfiltered geometry — the old behaviour, for comparison. */
  enforceStandard: boolean;
  detectXVoids: boolean;
  pairWalls: boolean;
  cutOpenings: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayGeometryOptions = {
  standard: DEFAULT_STANDARD_FILTER,
  pairing: DEFAULT_PAIRING,
  xVoid: DEFAULT_X_VOID,
  wallHeight: 3,
  doorHeight: 2.1,
  windowSill: 0.9,
  windowHeight: 1.2,
  enforceStandard: true,
  detectXVoids: true,
  pairWalls: true,
  cutOpenings: true,
};

/**
 * How far off a wall's centreline an opening may sit and still belong to it.
 *
 * Generous on purpose: a door is drawn against one FACE of a wall, not on its
 * centreline, so for a 300 mm wall the drawn position is 150 mm off before any
 * tolerance. Half the thickness plus this margin covers that.
 */
const OPENING_SNAP_MARGIN = 0.35;

/**
 * Layers where an X is something else and must not blank a region.
 *
 * Detection is by SHAPE and runs on the RAW candidates rather than on the
 * standard-filtered set, because the X is frequently drawn on an annotation or
 * area layer — `A-AREA-IDEN` is the natural home for it — and those layers do
 * not survive the filter. Running on raw lines means the exclusions here are
 * the only guard, so they are specific:
 *
 *  · `section` — an elevation or section view. A structural X-brace is a real
 *    X and would blank the room it happens to overlap in plan coordinates.
 *  · `hatch` — crossed hatching is a field of X shapes by construction.
 *  · `grid` — two setting-out lines cross at every grid intersection, at their
 *    midpoints, at a healthy angle, with comparable lengths. A plan's grid
 *    would otherwise blank the entire building.
 */
const X_DETECTION_EXCLUDED_ROLES = new Set(['section', 'hatch', 'grid']);

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * How parallel an opening entity is to its host wall: 1 is exactly along the
 * wall, 0 exactly across it.
 *
 * Used to pick which of several entities describing ONE opening actually
 * measures the hole. The one drawn ALONG the wall does; a leaf drawn open at
 * 90° measures the leaf.
 *
 * ── Two sources of direction, and the first one is often absent ───────────
 *
 * `ParsedWindow` carries `start`/`end`. **`ParsedDoor` does not** — it carries
 * `position`, `width` and `angle` (degrees) and nothing else. So an
 * endpoint-only implementation returned 0.5 for every door, 0.5 > 0.5 is
 * false, and the dedupe could never replace a worse door entity with a better
 * one. Whichever door entity the DXF happened to list first won, and with the
 * swing leaf first the door rendered 450 mm from its own hole.
 *
 * Caught by the entity-order check in `verify:display-geometry` §3b, which
 * exists because the forward order in the fixture happens to be the good one.
 *
 * So the declared `angle` is the fallback, which is exactly what a door has.
 * An entity with neither scores 0.5: neither preferred nor rejected, used when
 * nothing better exists and yielding to anything that states a direction.
 */
function alignment(
  source: any,
  ux: number,
  uy: number,
  wallRotationDeg: number,
): number {
  const start = point(source?.start);
  const end = point(source?.end);

  if (start && end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-9) {
      return Math.abs((dx / length) * ux + (dy / length) * uy);
    }
  }

  // Degrees, from the parser. `angle` is the canonical field and `rotation`
  // its documented alias.
  const declared = source?.angle ?? source?.rotation;
  if (Number.isFinite(Number(declared))) {
    const delta = ((Number(declared) - wallRotationDeg) * Math.PI) / 180;
    return Math.abs(Math.cos(delta));
  }

  return 0.5;
}

function point(value: any): Vec2 | null {
  if (!value) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

interface OpeningCandidate {
  source: any;
  kind: 'door' | 'window';
  index: number;
}

interface PlacedOpening {
  /** Distance along the wall from its start. */
  centre: number;
  width: number;
  bottom: number;
  top: number;
  candidate: OpeningCandidate;
}

export function buildDisplayGeometry(
  parsed: Record<string, any>,
  options: Partial<DisplayGeometryOptions> = {},
): DisplayGeometry {
  const opts: DisplayGeometryOptions = { ...DEFAULT_DISPLAY_OPTIONS, ...options };
  const warnings: string[] = [];

  const rawWalls: any[] = Array.isArray(parsed.walls) ? parsed.walls : [];

  // ── 1. X voids, from the RAW candidates ─────────────────────────────────
  //
  // Before the filter, because the X is usually on a layer the filter drops.
  let voids: DetectedVoid[] = [];
  if (opts.detectXVoids) {
    const eligible = rawWalls.filter((w) => {
      const role = standards.classify(String(w?.layer ?? '')).role;
      return !X_DETECTION_EXCLUDED_ROLES.has(role);
    });
    voids = detectXVoids(eligible, opts.xVoid);
  }

  // ── 2. The standard ─────────────────────────────────────────────────────
  const filtered = applyCadStandard(
    {
      walls: rawWalls,
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      doors: Array.isArray(parsed.doors) ? parsed.doors : [],
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
      columns: Array.isArray(parsed.columns) ? parsed.columns : [],
      stairs: Array.isArray(parsed.stairs) ? parsed.stairs : [],
      furniture: Array.isArray(parsed.furniture) ? parsed.furniture : [],
    },
    opts.enforceStandard ? opts.standard : { ...opts.standard, enforce: false },
  );
  warnings.push(...filtered.warnings, ...describeDropped(filtered.dropped));

  // Only walls the standard says are BUILT reach the pairing step. A void
  // layer (A-DOOR, A-GLAZ) survives `applyCadStandard` so that it can become
  // an opening, and pairing it would build the door as a wall.
  //
  // ── This has to honour `enforceStandard` too ───────────────────────────
  //
  // It did not, and the negative control in `verify:display-geometry` caught
  // it: `enforceStandard: false` still returned only A-WALL and A-WALL-PRTN,
  // because `applyCadStandard` was bypassed and then this second, independent
  // filter removed everything anyway. The flag is documented on the endpoint
  // as "returns unfiltered geometry — the old viewer behaviour", for bisecting
  // a bad import against a real drawing, and it silently did nothing.
  //
  // Two filters, one flag, and only one of them was wired to it. Worth
  // remembering as the shape: a disable switch is only as good as the LAST
  // thing that filters.
  const buildableWalls = opts.enforceStandard
    ? filtered.geometry.walls.filter(
        (w: any) => standards.classify(String(w?.layer ?? ''), w?.linetype).solid === 'build',
      )
    : filtered.geometry.walls;

  // ── 3. Pair the faces ───────────────────────────────────────────────────
  const paired = opts.pairWalls
    ? pairWallFaces(buildableWalls, opts.pairing)
    : {
        walls: buildableWalls.map((w: any, i: number) => ({
          id: String(w.id ?? `w${i}`),
          start: point(w.start) ?? { x: 0, y: 0 },
          end: point(w.end) ?? { x: 0, y: 0 },
          thickness: num(w.thickness, DEFAULT_PAIRING.defaultThickness),
          height: num(w.height, opts.wallHeight),
          layer: String(w.layer ?? ''),
          thicknessSource: 'default' as const,
          faceIds: [String(w.id ?? i)],
        })),
        paired: 0,
        unpaired: buildableWalls.length,
      };

  if (opts.pairWalls && paired.paired === 0 && paired.unpaired > 2) {
    warnings.push(
      `No wall could be paired with a second face, so every wall is using the ` +
        `${DEFAULT_PAIRING.defaultThickness} m default thickness. Walls are normally drawn as two ` +
        `parallel face lines; if this drawing draws them as single lines that is expected, ` +
        `and the thickness has to be set in the viewer instead.`,
    );
  }

  const wallHeight =
    num(parsed?.building?.floorHeight) > 1.8
      ? num(parsed.building.floorHeight)
      : opts.wallHeight;

  // ── 4. Match openings to walls, then split ──────────────────────────────
  const candidates: OpeningCandidate[] = [
    ...filtered.geometry.doors.map((source: any, index: number) => ({
      source,
      kind: 'door' as const,
      index,
    })),
    ...filtered.geometry.windows.map((source: any, index: number) => ({
      source,
      kind: 'window' as const,
      index: index + filtered.geometry.doors.length,
    })),
  ];

  const claimed = new Set<number>();
  const segments: DisplayWallSegment[] = [];
  const openings: DisplayOpening[] = [];

  for (const wall of paired.walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;

    const ux = dx / length;
    const uy = dy / length;
    const rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const height = wall.height > 1.8 ? wall.height : wallHeight;

    const placed: PlacedOpening[] = [];

    if (opts.cutOpenings) {
      for (const candidate of candidates) {
        if (claimed.has(candidate.index)) continue;

        const source = candidate.source;
        const start = point(source?.start);
        const end = point(source?.end);
        const position =
          point(source?.position) ??
          (start && end ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : null);
        if (!position) continue;

        const relX = position.x - wall.start.x;
        const relY = position.y - wall.start.y;
        const along = relX * ux + relY * uy;
        const perpendicular = Math.abs(relX * -uy + relY * ux);

        if (perpendicular > wall.thickness / 2 + OPENING_SNAP_MARGIN) continue;

        // A width taken from the drawing when there is one; otherwise the
        // usual leaf for its kind. A 0 would produce a zero-width hole that
        // reads as "the door is missing" rather than "the width is unknown".
        let width = num(source?.width);
        if (!(width > 0) && start && end) width = Math.hypot(end.x - start.x, end.y - start.y);
        if (!(width > 0)) width = candidate.kind === 'door' ? 0.9 : 1.2;

        if (along < -width / 2 || along > length + width / 2) continue;

        // ── One physical opening, drawn as several entities ───────────────
        //
        // A door is drawn as a leaf line AND a swing arc; a window as two
        // sill lines. The parser emits one opening per entity, so a single
        // door arrives two or three times at the same point on the same wall.
        // Cutting the same hole twice is harmless, but each duplicate also
        // renders its own leaf and inflates the count, so the operator sees
        // "4 openings" for two.
        //
        // Same kind, same wall, centres within three quarters of a leaf width:
        // one opening drawn twice. Two genuinely separate doors are never that
        // close — their leaves would overlap — so the tolerance is safe, and it
        // has to be this wide because the entities of one door are NOT
        // concentric. A door drawn open at 90° (per section F of the client's
        // drawing library) puts its leaf line half a leaf away from the
        // opening, along the wall AND across it.
        //
        // The duplicate is CLAIMED rather than skipped, so it cannot go on to
        // match a different wall and reappear as a phantom door.
        const tolerance = Math.max(width, ...placed.map((p) => p.width), 0) * 0.75;
        const duplicate = placed.find(
          (p) =>
            p.candidate.kind === candidate.kind &&
            Math.abs(p.centre - along) < tolerance,
        );
        if (duplicate) {
          claimed.add(candidate.index);
          // ── Which entity measures the opening? ──────────────────────────
          //
          // The one drawn ALONG the wall. A leaf drawn open at 90° is
          // perpendicular to it and measures the leaf, not the hole — taking
          // its position would offset the opening by half a leaf, and in 3D a
          // door half a leaf from its hole reads as a door floating beside the
          // wall. So a more-parallel entity replaces a less-parallel one; a
          // less-parallel one is absorbed and discarded.
          if (
            alignment(source, ux, uy, rotationDeg) >
            alignment(duplicate.candidate.source, ux, uy, rotationDeg)
          ) {
            duplicate.centre = along;
            duplicate.width = width;
            duplicate.candidate = candidate;
          }
          continue;
        }

        const bottom =
          candidate.kind === 'door'
            ? 0
            : num(source?.sillHeight, opts.windowSill) >= 0
              ? num(source?.sillHeight, opts.windowSill)
              : opts.windowSill;

        const openingHeight =
          num(source?.height) > 0
            ? num(source.height)
            : candidate.kind === 'door'
              ? opts.doorHeight
              : opts.windowHeight;

        const top = Math.min(height, bottom + openingHeight);

        claimed.add(candidate.index);
        placed.push({ centre: along, width, bottom, top, candidate });
      }
    }

    // ── Openings are emitted from the FINAL placements, not as they arrive ──
    //
    // This used to push an opening the moment a candidate matched, and the
    // dedupe above can afterwards REPLACE a placement's centre and width with
    // a better-aligned entity's. So the hole came out in the corrected place
    // and the door's own position kept the superseded value — a door rendered
    // up to half a leaf away from its own opening.
    //
    // It did not show up in the verification because the parallel entity
    // happens to come first in the fixture's entity order, so no replacement
    // ever ran. Order of entities in a DXF is the draughtsman's business, not
    // a property to rely on. Emitting after the loop means there is exactly
    // one source for both the hole and the leaf.
    for (const item of placed) {
      const source = item.candidate.source;
      openings.push({
        id: String(source.id ?? `${item.candidate.kind}-${item.candidate.index}`),
        kind: item.candidate.kind,
        // Snapped ONTO the wall centreline. The drawn position sits against a
        // FACE; leaving it there puts the door half a wall off-centre, which
        // in 3D reads as a door floating beside its hole.
        position: {
          x: wall.start.x + ux * item.centre,
          y: wall.start.y + uy * item.centre,
        },
        width: item.width,
        height: item.top - item.bottom,
        sill: item.bottom,
        // From the HOST WALL, not the drawing's own angle field. A door is in
        // a wall and shares its direction; the parser's `angle` comes from
        // whichever line it happened to measure and is frequently the swing
        // arc rather than the leaf.
        rotation: rotationDeg,
        wallThickness: wall.thickness,
        wallId: wall.id,
        layer: String(source.layer ?? ''),
      });
    }

    // ── Split the wall into the solid pieces around its openings ──────────
    //
    // A door reaches the floor, so it leaves solid only above it. A window
    // leaves solid below the sill and above the head. Splitting along the wall
    // and stacking vertically is exact for the axis-aligned rectangular
    // openings that doors and windows are, and needs no boolean geometry.
    placed.sort((a, b) => a.centre - b.centre);

    let cursor = 0;
    let pieces = 0;
    const push = (from: number, to: number, bottom: number, top: number) => {
      if (to - from < 1e-4 || top - bottom < 1e-4) return;
      segments.push({
        id: `${wall.id}:s${pieces++}`,
        wallId: wall.id,
        start: { x: wall.start.x + ux * from, y: wall.start.y + uy * from },
        end: { x: wall.start.x + ux * to, y: wall.start.y + uy * to },
        thickness: wall.thickness,
        bottom,
        top,
        layer: wall.layer,
        thicknessSource: wall.thicknessSource,
      });
    };

    for (const opening of placed) {
      const from = Math.max(0, opening.centre - opening.width / 2);
      const to = Math.min(length, opening.centre + opening.width / 2);

      if (from > cursor) push(cursor, from, 0, height);

      // Below the opening (a window's spandrel) and above it (the lintel).
      if (opening.bottom > 0) push(from, to, 0, opening.bottom);
      if (opening.top < height) push(from, to, opening.top, height);

      cursor = Math.max(cursor, to);
    }

    if (cursor < length) push(cursor, length, 0, height);
  }

  const unmatched = candidates.length - claimed.size;
  if (unmatched > 0) {
    warnings.push(
      `${unmatched} of ${candidates.length} openings could not be matched to a wall and are not ` +
        `cut. They are usually drawn further than the snap tolerance from any wall centreline, ` +
        `or their wall was excluded by the standard.`,
    );
  }

  // Openings that matched nothing are still returned, positioned where the
  // drawing put them, so they are visible and findable rather than silently
  // absent.
  for (const candidate of candidates) {
    if (claimed.has(candidate.index)) continue;
    const source = candidate.source;
    const position =
      point(source?.position) ??
      (point(source?.start) && point(source?.end)
        ? {
            x: (source.start.x + source.end.x) / 2,
            y: (source.start.y + source.end.y) / 2,
          }
        : null);
    if (!position) continue;

    openings.push({
      id: String(source.id ?? `${candidate.kind}-${candidate.index}`),
      kind: candidate.kind,
      position,
      width: num(source?.width, candidate.kind === 'door' ? 0.9 : 1.2),
      height: num(source?.height, candidate.kind === 'door' ? opts.doorHeight : opts.windowHeight),
      sill: candidate.kind === 'door' ? 0 : opts.windowSill,
      rotation: num(source?.rotation ?? source?.angle),
      wallThickness: DEFAULT_PAIRING.defaultThickness,
      wallId: null,
      layer: String(source.layer ?? ''),
    });
  }

  // ── 5. Nothing is placed in a crossed-out space ─────────────────────────
  const rawDevices: any[] = Array.isArray(parsed.devices) ? parsed.devices : [];
  const deviceResult = suppressInsideVoids(rawDevices as any[], voids);

  // Furniture is CONTENTS, exactly like a device marker, so the same rule
  // applies: the space keeps its floor, its ceiling and its walls, and nothing
  // is placed in it. Structure — columns, stairs, the walls that bound the
  // space — is deliberately NOT suppressed: a column inside a region nobody
  // has fitted out is still holding the building up.
  const rawFurniture: any[] = Array.isArray(filtered.geometry.furniture)
    ? filtered.geometry.furniture
    : [];
  const furnitureResult = suppressInsideVoids(rawFurniture as any[], voids);

  const suppressed = deviceResult.dropped + furnitureResult.dropped;
  if (suppressed > 0) {
    warnings.push(
      `${suppressed} item(s) — ${deviceResult.dropped} device marker(s) and ` +
        `${furnitureResult.dropped} piece(s) of furniture — sit inside a space marked empty ` +
        `with an X and were not placed. The space keeps its floor and walls; only its ` +
        `contents are omitted.`,
    );
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of segments) {
    xs.push(s.start.x, s.end.x);
    ys.push(s.start.y, s.end.y);
  }
  for (const room of filtered.geometry.rooms) {
    for (const v of room.vertices ?? room.boundaries ?? []) {
      if (Number.isFinite(v?.x) && Number.isFinite(v?.y)) {
        xs.push(v.x);
        ys.push(v.y);
      }
    }
  }
  const bounds =
    xs.length > 0
      ? {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };

  return {
    walls: segments,
    openings,
    rooms: filtered.geometry.rooms.map((r: any, i: number) => ({
      id: String(r.id ?? `room-${i}`),
      vertices: (r.vertices ?? r.boundaries ?? []).filter(
        (v: any) => Number.isFinite(v?.x) && Number.isFinite(v?.y),
      ),
      center: point(r.center) ?? { x: 0, y: 0 },
      area: num(r.area),
      name: r.label ?? r.name,
      layer: String(r.layer ?? ''),
    })),
    columns: filtered.geometry.columns,
    stairs: filtered.geometry.stairs,
    devices: deviceResult.kept,
    furniture: furnitureResult.kept,
    voids,
    bounds,
    wallHeight,
    units: 'm',
    stats: {
      wallCandidates: rawWalls.length,
      wallsAfterStandard: buildableWalls.length,
      wallsPaired: paired.paired,
      wallsUnpaired: paired.unpaired,
      segments: segments.length,
      openingsMatched: claimed.size,
      openingsUnmatched: unmatched,
      voids: voids.length,
      devicesSuppressedByVoid: deviceResult.dropped,
      furnitureSuppressedByVoid: furnitureResult.dropped,
    },
    excluded: filtered.dropped,
    warnings,
  };
}
