/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Tread lines → stair flights
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE PROBLEM THIS SOLVES
 *
 * A staircase in plan is not drawn as "a staircase". It is drawn as one line
 * per tread nosing — fourteen parallel lines, plus the arrow, plus the
 * enclosing walls. The reference library drawing contains 154 such lines
 * across its two stair layers.
 *
 * The importer treated every one of those lines as a staircase in its own
 * right and built a full flight from each: 154 overlapping staircases,
 * roughly 2,500 step boxes stacked through each other. That is what makes an
 * imported plan render as grey mush, and it is why stairs "don't show
 * properly" — they show far too much, all in the same place.
 *
 * THE FIX
 *
 * Recognise the pattern. Treads in one flight are:
 *   • parallel to each other,
 *   • of similar length (the flight's width),
 *   • evenly spaced, by the going — 250-350 mm in practice,
 *   • overlapping when projected along their own direction.
 *
 * So the lines are grouped by direction, sorted across the run, and cut into
 * clusters wherever the spacing or the overlap breaks. Each surviving cluster
 * is one flight, with a real step count taken from the number of treads
 * instead of a hardcoded guess.
 *
 * Nothing here invents geometry: a flight's width, run, direction and step
 * count all come from the lines the drawing actually contains.
 */

export interface StairSegment {
  start: { x: number; y: number; z?: number };
  end: { x: number; y: number; z?: number };
  layer: string;
}

export interface StairFlight {
  layer: string;
  /** Centre of the first tread's leading edge. */
  origin: { x: number; y: number };
  /** Unit vector along the direction of travel, across the treads. */
  run: { x: number; y: number };
  /** Total going, in metres. */
  runLength: number;
  /** Flight width, in metres — the median tread length. */
  width: number;
  /** Number of treads found in the drawing. */
  steps: number;
}

export interface StairAssemblyResult {
  flights: StairFlight[];
  /** Segments that formed no flight — landing nosings, handrails, arrows. */
  orphans: number;
  warnings: string[];
}

/** Two directions count as parallel within this many degrees. */
const ANGLE_TOLERANCE_DEG = 6;

/**
 * Plausible going (tread depth) between adjacent nosings, in metres.
 *
 * Deliberately wider than the 250-350 the standard requires for a compliant
 * stair: the job here is to recognise a flight, including a non-compliant
 * one, and `checkStair()` is what reports whether it meets the rule. A
 * narrow window here would silently fail to group exactly the stairs the
 * operator most needs to see flagged.
 */
const MIN_GOING = 0.12;
const MAX_GOING = 0.6;

/** A cluster needs at least this many treads before it is called a flight. */
const MIN_TREADS = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface Tread {
  /** Midpoint. */
  mx: number;
  my: number;
  length: number;
  /** Position across the run — the coordinate flights are cut along. */
  across: number;
  /** Extent along the tread's own direction, for the overlap test. */
  alongMin: number;
  alongMax: number;
}

/**
 * Group tread lines into flights.
 *
 * Segments are expected to be pre-filtered to stair layers; this function
 * does not classify.
 */
export function assembleStairFlights(
  segments: StairSegment[],
): StairAssemblyResult {
  const flights: StairFlight[] = [];
  const warnings: string[] = [];
  let orphans = 0;

  // Flights are assembled per layer, so the flight below the cut plane and
  // the flight above it stay separate objects at separate heights rather
  // than merging into one impossible 30-step run.
  const byLayer = new Map<string, StairSegment[]>();
  for (const s of segments) {
    const key = s.layer ?? '';
    const list = byLayer.get(key);
    if (list) list.push(s);
    else byLayer.set(key, [s]);
  }

  for (const [layer, items] of byLayer) {
    // ── Group by direction ──────────────────────────────────────────────
    //
    // Keyed on angle modulo 180: a tread drawn left-to-right and its
    // neighbour drawn right-to-left are the same direction, and splitting
    // them would halve every flight.
    const directions: Array<{ angle: number; treads: Tread[]; ux: number; uy: number }> = [];

    for (const seg of items) {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) {
        orphans++;
        continue;
      }

      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      angle = ((angle % 180) + 180) % 180;

      let group = directions.find((g) => {
        const d = Math.abs(g.angle - angle);
        return Math.min(d, 180 - d) <= ANGLE_TOLERANCE_DEG;
      });
      if (!group) {
        group = { angle, treads: [], ux: dx / length, uy: dy / length };
        directions.push(group);
      }

      // Measured against the GROUP's axis, not the segment's own, so every
      // tread in a flight is projected onto one consistent pair of axes.
      const ux = group.ux;
      const uy = group.uy;
      const px = -uy;
      const py = ux;

      const mx = (seg.start.x + seg.end.x) / 2;
      const my = (seg.start.y + seg.end.y) / 2;

      const a0 = seg.start.x * ux + seg.start.y * uy;
      const a1 = seg.end.x * ux + seg.end.y * uy;

      group.treads.push({
        mx,
        my,
        length,
        across: mx * px + my * py,
        alongMin: Math.min(a0, a1),
        alongMax: Math.max(a0, a1),
      });
    }

    // ── Cut each direction group into flights ───────────────────────────
    for (const group of directions) {
      const treads = group.treads.sort((a, b) => a.across - b.across);
      if (treads.length === 0) continue;

      let cluster: Tread[] = [treads[0]];

      const flush = () => {
        if (cluster.length >= MIN_TREADS) {
          const flight = toFlight(layer, cluster, group.ux, group.uy);
          if (flight) flights.push(flight);
          else orphans += cluster.length;
        } else {
          orphans += cluster.length;
        }
        cluster = [];
      };

      for (let i = 1; i < treads.length; i++) {
        const prev = treads[i - 1];
        const curr = treads[i];
        const gap = curr.across - prev.across;

        // Do the two treads sit over each other along their own length? Two
        // parallel lines 300 apart in different parts of the building are
        // not consecutive treads of one flight.
        const overlap =
          Math.min(prev.alongMax, curr.alongMax) -
          Math.max(prev.alongMin, curr.alongMin);
        const shorter = Math.min(
          prev.alongMax - prev.alongMin,
          curr.alongMax - curr.alongMin,
        );
        const overlaps = shorter <= 0 ? false : overlap / shorter > 0.5;

        if (gap >= MIN_GOING && gap <= MAX_GOING && overlaps) {
          cluster.push(curr);
        } else {
          flush();
          cluster = [curr];
        }
      }
      flush();
    }
  }

  if (orphans > 0) {
    const detail = flights.length
      ? `${flights.length} flight(s) totalling ${flights.reduce(
          (n, f) => n + f.steps,
          0,
        )} treads were built`
      : 'no flights were built at all';

    warnings.push(
      `${orphans} line(s) on stair layers did not form part of a flight, and ` +
        `${detail}. Unmatched lines are normally landing nosings, handrail ` +
        `centrelines, direction arrows or the dimension diagrams on a ` +
        `standards sheet — a line must sit parallel to at least two others, ` +
        `${MIN_GOING * 1000}-${MAX_GOING * 1000} mm away and overlapping ` +
        `them, before it counts as a tread. If stairs are missing from the ` +
        `model, check that their treads are drawn individually rather than ` +
        `as a single hatched block.`,
    );
  }

  return { flights, orphans, warnings };
}

function toFlight(
  layer: string,
  cluster: Tread[],
  ux: number,
  uy: number,
): StairFlight | null {
  const first = cluster[0];
  const last = cluster[cluster.length - 1];

  // Perpendicular to the treads is the direction of travel.
  let rx = -uy;
  let ry = ux;

  // Orient it from the first tread towards the last, so the flight rises in
  // the direction the treads actually progress rather than backwards half
  // the time depending on which way the lines were drawn.
  const dx = last.mx - first.mx;
  const dy = last.my - first.my;
  if (dx * rx + dy * ry < 0) {
    rx = -rx;
    ry = -ry;
  }

  const span = Math.abs(last.across - first.across);
  const going = span / Math.max(1, cluster.length - 1);
  const runLength = span + going; // one more going for the final tread
  const width = median(cluster.map((t) => t.length));

  if (!Number.isFinite(runLength) || runLength <= 0) return null;
  if (!Number.isFinite(width) || width <= 0) return null;

  return {
    layer,
    // Step back half a going from the first nosing, so the flight starts at
    // the leading edge of tread one rather than at its centreline.
    origin: { x: first.mx - rx * (going / 2), y: first.my - ry * (going / 2) },
    run: { x: rx, y: ry },
    runLength,
    width,
    steps: cluster.length,
  };
}
