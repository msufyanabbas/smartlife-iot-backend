/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The "X" convention: an X drawn over a space means that space is EMPTY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A client convention, stated directly: *"if there is an 'X' symbol in the
 * drawing, it means that space is empty."*
 *
 * Worth recording precisely what this is and is not, because the convention is
 * NOT in either of the two reference drawings supplied with the standard. The
 * master template's section 9 symbol legend lists twenty-two blocks
 * (`SYM-LIGHT`, `SYM-CCTV-DOME`, `SYM-SMOKE-DET`, …) and none of them is a
 * cross; nothing in the drawing library defines one either. So this is
 * implemented from the client's description rather than transcribed from a
 * file, and the two decisions behind it were confirmed with him directly:
 *
 *   · **The slab STAYS.** An X marks a space that is not fitted out — out of
 *     scope, not yet allocated — not a shaft. So the floor, the ceiling and
 *     the bounding walls are all built exactly as they would be otherwise.
 *     (The alternative reading, cutting a hole through the slab, is what a
 *     lift shaft or an atrium needs; that is a different mark and is not this
 *     one. `kind` is on the result so the hole case can be added later without
 *     changing the detection.)
 *   · **Any layer.** The X is detected by its SHAPE, not by the layer it sits
 *     on, so a drawing from a third party works without first teaching the
 *     importer that party's layer names.
 *
 * ── Detecting an X ─────────────────────────────────────────────────────────
 *
 * Two line segments form an X when:
 *
 *   1. They genuinely INTERSECT — the crossing point lies strictly inside both
 *      segments, not at or beyond an endpoint. A corner, a T-junction and two
 *      walls meeting all fail this, which is most of what would otherwise be a
 *      false positive.
 *   2. They cross near their MIDPOINTS. On a real X the diagonals bisect each
 *      other; a line clipping the corner of another does not. The tolerance is
 *      a fraction of each segment's own length, so it scales with the mark.
 *   3. They are not close to parallel. Two diagonals of a rectangle meet at a
 *      healthy angle; a doubled line or a hatch does not cross at all, but a
 *      sheared one could, and the angle test refuses it.
 *   4. Their lengths are COMPARABLE. The two strokes of an X are within a
 *      factor of `maxLengthRatio` of each other. A long service run crossing a
 *      short dimension tick satisfies everything above and is not an X.
 *
 * The region marked is the bounding box of the two strokes, which for a
 * corner-to-corner X is exactly the region the draughtsman crossed out.
 *
 * ── Known limits, stated rather than hidden ────────────────────────────────
 *
 * · A single diagonal is not an X and is ignored. That is deliberate: one
 *   diagonal line is far too common to treat as a command to blank a region.
 * · A cross drawn as four strokes meeting in the middle (a "+" rotated, or an
 *   X drawn stroke-by-stroke from the centre) is not detected, because none of
 *   its strokes crosses another's midpoint. If the client's drawings do that,
 *   the fix is to cluster strokes by shared endpoint first.
 * · An X-brace in a structural elevation is a real X and WILL be detected. It
 *   is on a structural layer in a section view, which the drawing standard
 *   already excludes from plan geometry (§4m), so it does not reach here — but
 *   it is the reason detection is confined to the geometry that survives the
 *   standard filter rather than run over the raw entity list.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface XMarkSource {
  id?: string;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  layer?: string;
  [key: string]: any;
}

export interface DetectedVoid {
  id: string;
  /**
   * What the mark means for the model. Today always `not_fitted_out`: the slab
   * and ceiling stay and only contents are suppressed. `open_void` (a real
   * hole) is reserved for a future mark and is never produced here.
   */
  kind: 'not_fitted_out';
  /** Axis-aligned region the X covers, in metres. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** The region as a polygon, so a viewer can shade it. */
  vertices: Vec2[];
  center: Vec2;
  /** Square metres. */
  area: number;
  /** The crossing point of the two strokes. */
  crossing: Vec2;
  layer: string;
  /** The ids of the two strokes, for tracing back to the drawing. */
  strokeIds: string[];
}

export interface XVoidOptions {
  /**
   * How far from a segment's own midpoint the crossing may sit, as a fraction
   * of that segment's length. 0.25 means the middle half of each stroke.
   */
  midpointTolerance: number;
  /** Minimum angle between the strokes, in degrees. */
  minAngleDeg: number;
  /** The longer stroke may be at most this many times the shorter. */
  maxLengthRatio: number;
  /** Metres. Strokes shorter than this are ticks and leader lines. */
  minStrokeLength: number;
  /** Square metres. A region smaller than this is a symbol, not a space. */
  minArea: number;
}

export const DEFAULT_X_VOID: XVoidOptions = {
  midpointTolerance: 0.25,
  // 25°: a square's diagonals cross at 90°, a 3:1 rectangle's at about 37°.
  // Below 25° the "X" is two nearly-parallel lines and far more likely to be
  // something else.
  minAngleDeg: 25,
  maxLengthRatio: 2.5,
  // 300 mm: shorter strokes are dimension ticks, hatch strokes and the
  // crossings inside symbols.
  minStrokeLength: 0.3,
  // 1 m²: below this it is a symbol on the drawing, not a space in the
  // building. A 1 m² cupboard is not something anyone crosses out.
  minArea: 1,
};

const EPSILON = 1e-9;

interface Stroke {
  id: string;
  a: Vec2;
  b: Vec2;
  mid: Vec2;
  length: number;
  layer: string;
}

function toStroke(source: XMarkSource, index: number): Stroke | null {
  const a = { x: Number(source?.start?.x), y: Number(source?.start?.y) };
  const b = { x: Number(source?.end?.x), y: Number(source?.end?.y) };
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;

  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < EPSILON) return null;

  return {
    id: String(source.id ?? `x${index}`),
    a,
    b,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    length,
    layer: String(source.layer ?? ''),
  };
}

/**
 * Where two segments cross, as parameters along each.
 *
 * Returns null for parallel segments and for a crossing outside either
 * segment's own span — an INTERSECTION, not the meeting of two infinite lines.
 */
function crossParameters(
  p: Stroke,
  q: Stroke,
): { t: number; u: number; point: Vec2 } | null {
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  const s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };

  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < EPSILON) return null; // parallel

  const qp = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
  const t = (qp.x * s.y - qp.y * s.x) / denominator;
  const u = (qp.x * r.y - qp.y * r.x) / denominator;

  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null; // beyond an endpoint

  return { t, u, point: { x: p.a.x + r.x * t, y: p.a.y + r.y * t } };
}

export function detectXVoids(
  sources: XMarkSource[],
  options: Partial<XVoidOptions> = {},
): DetectedVoid[] {
  const opts: XVoidOptions = { ...DEFAULT_X_VOID, ...options };

  const strokes: Stroke[] = [];
  sources.forEach((source, i) => {
    const s = toStroke(source, i);
    if (s && s.length >= opts.minStrokeLength) strokes.push(s);
  });

  const minCos = Math.cos((opts.minAngleDeg * Math.PI) / 180);

  /**
   * Every pair that qualifies, scored, BEST FIRST — not the first pair found.
   *
   * This used to be a nested loop that claimed the first qualifying partner
   * and moved on, which made the answer depend on the order the draughtsman
   * happened to draw in. §4v states the rule ("entity order must not change
   * the answer") and this was breaking it.
   *
   * It is not theoretical. In the test drawing the demolished partition runs
   * (5, 0.2)-(5, 7.8) and crosses the X's first stroke at (5, 5) — within the
   * midpoint tolerance of both, at 45 degrees, with a length ratio of 1.8. It
   * qualifies. Whichever of the two candidates sits earlier in the array wins,
   * so with the X drawn first the detector found the real 9 m-square void, and
   * with the partition first it claimed half the X, invented a 22.8 m-square
   * "empty space" over a wall that was merely being torn out, and left the
   * other half of the cross standing in the model.
   *
   * Scoring both and taking the better one is what makes that impossible: a
   * real X crosses at both midpoints, at a right angle, with equal arms, so it
   * beats an incidental crossing on all three terms at once.
   */
  type Candidate = {
    p: Stroke;
    q: Stroke;
    score: number;
    crossing: { t: number; u: number; point: { x: number; y: number } };
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    area: number;
  };

  const candidates: Candidate[] = [];

  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      const p = strokes[i];
      const q = strokes[j];

      // 4. Comparable lengths.
      const ratio = Math.max(p.length, q.length) / Math.min(p.length, q.length);
      if (ratio > opts.maxLengthRatio) continue;

      // 1. A real intersection, strictly inside both.
      const crossing = crossParameters(p, q);
      if (!crossing) continue;

      // 2. Near both midpoints. `t` and `u` are already normalised to [0,1],
      // so the test is the same fraction on each regardless of length.
      const dt = Math.abs(crossing.t - 0.5);
      const du = Math.abs(crossing.u - 0.5);
      if (dt > opts.midpointTolerance) continue;
      if (du > opts.midpointTolerance) continue;

      // 3. Crossing at a healthy angle.
      const ux = (p.b.x - p.a.x) / p.length;
      const uy = (p.b.y - p.a.y) / p.length;
      const vx = (q.b.x - q.a.x) / q.length;
      const vy = (q.b.y - q.a.y) / q.length;
      const cos = Math.abs(ux * vx + uy * vy);
      if (cos > minCos) continue;

      const xs = [p.a.x, p.b.x, q.a.x, q.b.x];
      const ys = [p.a.y, p.b.y, q.a.y, q.b.y];
      const bounds = {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      };
      const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
      if (area < opts.minArea) continue;

      // Lower is better, and 0 is a geometrically perfect cross. The midpoint
      // term is doubled because that is the signal that separates a symbol
      // someone drew on purpose from two lines that happen to meet.
      const score = (Math.max(dt, du) * 2) + (ratio - 1) + cos;
      candidates.push({ p, q, score, crossing, bounds, area });
    }
  }

  // Ties break on the stroke ids so the result is stable, not merely
  // order-independent — two runs over the same drawing must agree.
  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      `${a.p.id}/${a.q.id}`.localeCompare(`${b.p.id}/${b.q.id}`),
  );

  const claimed = new Set<string>();
  const voids: DetectedVoid[] = [];

  for (const c of candidates) {
    if (claimed.has(c.p.id) || claimed.has(c.q.id)) continue;
    claimed.add(c.p.id);
    claimed.add(c.q.id);

    voids.push({
      id: `void-${c.p.id}-${c.q.id}`,
      kind: 'not_fitted_out',
      bounds: c.bounds,
      vertices: [
        { x: c.bounds.minX, y: c.bounds.minY },
        { x: c.bounds.maxX, y: c.bounds.minY },
        { x: c.bounds.maxX, y: c.bounds.maxY },
        { x: c.bounds.minX, y: c.bounds.maxY },
      ],
      center: {
        x: (c.bounds.minX + c.bounds.maxX) / 2,
        y: (c.bounds.minY + c.bounds.maxY) / 2,
      },
      area: c.area,
      crossing: c.crossing.point,
      layer: c.p.layer || c.q.layer,
      strokeIds: [c.p.id, c.q.id],
    });
  }

  return voids;
}

/** True when a point lies inside a detected void's region. */
export function isInsideVoid(point: Vec2, region: DetectedVoid): boolean {
  return (
    point.x >= region.bounds.minX &&
    point.x <= region.bounds.maxX &&
    point.y >= region.bounds.minY &&
    point.y <= region.bounds.maxY
  );
}

/**
 * Remove items whose position falls in a crossed-out region.
 *
 * This is the whole effect of the convention: the space keeps its floor and
 * its walls, and nothing is placed in it. Returns the survivors and a count,
 * because "7 devices were dropped because they sit in a space marked empty" is
 * something the operator has to be told — silently discarding placements is
 * how an importer loses a floor's worth of sensors without saying so.
 */
export function suppressInsideVoids<T extends { position?: Vec2; x?: number; y?: number }>(
  items: T[],
  voids: DetectedVoid[],
): { kept: T[]; dropped: number } {
  if (voids.length === 0) return { kept: items, dropped: 0 };

  const kept: T[] = [];
  let dropped = 0;

  for (const item of items) {
    const point =
      item.position && Number.isFinite(item.position.x)
        ? item.position
        : Number.isFinite(item.x) && Number.isFinite(item.y)
          ? { x: item.x as number, y: item.y as number }
          : null;

    if (point && voids.some((v) => isInsideVoid(point, v))) {
      dropped++;
      continue;
    }
    kept.push(item);
  }

  return { kept, dropped };
}


/**
 * Roles where a crossing pair of lines is something other than the "this
 * space is empty" mark.
 *
 *  · `section` — a structural X-brace in an elevation IS an X.
 *  · `hatch`   — crossed hatching is a field of X shapes by construction.
 *  · `grid`    — two setting-out lines cross at every intersection, at their
 *                midpoints, at a healthy angle, with comparable lengths. A
 *                plan's grid would otherwise blank the whole building.
 */
export const X_IGNORED_ROLES = new Set(['section', 'hatch', 'grid']);

/**
 * Layer STATUSES that cannot be half of an X.
 *
 * `A-WALL-DEMO` is a partition being torn out and `-FUTR` is one not built
 * yet; §4m already excludes both from the fabric because each models a
 * building that is never real at any one moment. They have to be excluded
 * here too, and for a separate reason: a long demolition line crossing a
 * genuine X stroke near its midpoint satisfies every geometric test for a
 * cross, so leaving it in means competing against the real pair. Status is
 * not a role, which is why this is a second set rather than more entries in
 * the one above.
 */
export const X_IGNORED_STATUSES = new Set(['DEMO', 'FUTR']);

/** Whether a layer's geometry may be read as part of an X symbol. */
export function isXStrokeLayer(classification: {
  role?: string;
  status?: string;
}): boolean {
  if (X_IGNORED_ROLES.has(String(classification?.role ?? ''))) return false;
  return !X_IGNORED_STATUSES.has(String(classification?.status ?? ''));
}

/**
 * Remove the strokes of every X from a parsed drawing, and report the regions.
 *
 * ── Why this is applied in TWO places ──────────────────────────────────────
 *
 * The client's standard says a crossed-out box is an empty space, and what he
 * wants to see is the box with **no X in it** — identical to a box that never
 * carried one. So the strokes are an annotation and must not reach any
 * renderer.
 *
 * `DxfFloorPlanParser.parse()` calls this, which cleans every NEW upload. But
 * a drawing imported before this existed has its X strokes baked into the
 * stored `parsedGeometry` jsonb, and re-uploading every plan is not a
 * reasonable thing to ask. So the READ path calls it too, which fixes the
 * existing data in place without a migration and without touching the stored
 * row.
 *
 * Idempotent: running it on already-clean geometry finds no X and returns the
 * input unchanged, so applying it twice costs one pass and changes nothing.
 *
 * @param classifyRole resolves a layer name to the drawing standard's role.
 *        Injected rather than imported so this module stays free of the
 *        standards service — `x-void.ts` is pure geometry and is unit-tested
 *        as such.
 */
export function stripXStrokes<
  T extends {
    walls?: any[];
    lines?: any[];
    voids?: DetectedVoid[];
  },
>(
  geometry: T,
  classify: (layer: string) => { role?: string; status?: string },
  options: Partial<XVoidOptions> = {},
): { geometry: T; voids: DetectedVoid[]; removed: number } {
  const walls = Array.isArray(geometry?.walls) ? geometry.walls : [];
  if (walls.length === 0) {
    return { geometry, voids: geometry?.voids ?? [], removed: 0 };
  }

  const eligible = walls.filter((w: any) =>
    isXStrokeLayer(classify(String(w?.layer ?? ''))),
  );
  const voids = detectXVoids(eligible, options);
  if (voids.length === 0) {
    return { geometry, voids: geometry?.voids ?? [], removed: 0 };
  }

  const strokeIds = new Set(voids.flatMap((v) => v.strokeIds));
  const strokes = walls.filter((w: any) => strokeIds.has(String(w?.id)));

  // Matched by GEOMETRY, not by id. `lines` and `walls` are minted from one
  // counter but with different prefixes, so an id match would depend on that
  // numbering staying in step — and `lines` is what `FloorPlanCanvas` falls
  // back to when it finds no usable walls, so leaving the stroke there would
  // simply move which renderer draws it.
  const isStroke = (item: any) =>
    strokes.some(
      (s: any) =>
        Math.abs(s.start.x - item?.start?.x) < 1e-9 &&
        Math.abs(s.start.y - item?.start?.y) < 1e-9 &&
        Math.abs(s.end.x - item?.end?.x) < 1e-9 &&
        Math.abs(s.end.y - item?.end?.y) < 1e-9,
    );

  const keptLines = Array.isArray(geometry.lines)
    ? geometry.lines.filter((l: any) => !(l?.start && l?.end && isStroke(l)))
    : geometry.lines;

  return {
    geometry: {
      ...geometry,
      walls: walls.filter((w: any) => !strokeIds.has(String(w?.id))),
      ...(keptLines ? { lines: keptLines } : {}),
      voids,
    },
    voids,
    removed: strokeIds.size,
  };
}
