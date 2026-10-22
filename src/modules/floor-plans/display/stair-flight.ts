/**
 * The VERTICAL half of a staircase: risers, tread heights, handrails and the
 * compliance report.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 *
 * It does not group tread lines into flights. `mesh/stair-flight.ts` already
 * does that — and did so before this file existed — with the grouping rules
 * written out: per LAYER (so the flight below the cut plane and the flight
 * above it stay separate rather than merging into one impossible 30-step
 * run), by direction modulo 180, within a 120-600 mm going window, with an
 * overlap test across the run and a three-tread minimum, counting whatever
 * forms no flight as an orphan.
 *
 * This module was first written with its own copy of all of that. That was a
 * mistake of exactly the kind §4m warns about — "re-implementing the matching
 * in either place is how two copies drift apart" — and it would have been a
 * worse one than usual, because the two copies would have put the staircases
 * of one drawing in different places on the export path and the viewer path.
 * That is the §4v defect, the standard not reaching the viewer, reappearing
 * one module along.
 *
 * So `assembleStairFlights` is the single grouping implementation, and what is
 * left here is the part the mesh path never needed: how high each tread is.
 *
 * ── Why the vertical half is separate at all ────────────────────────────────
 *
 * A plan is a horizontal section. It records the going, because you can
 * measure it between two nosings, and says nothing whatsoever about the riser.
 * So the rise per step is `storeyHeight / riserCount`, and the riser count is
 * one MORE than the tread count: the top riser lands on the floor above and
 * has no tread drawn in plan.
 *
 * Getting that off by one is a stair that misses its landing by one step,
 * which in a walkthrough means climbing into the underside of the slab.
 *
 * ── The standard is consulted, not re-implemented ───────────────────────────
 *
 * `CadStandardsService.checkStair()` holds LIB-04's riser, going, Blondel
 * (2R+G), pitch, width and rise-per-flight limits. This module measures and
 * asks; it does not restate a single limit. A non-compliant flight is still
 * built and still reported — refusing to draw a steep stair hides the
 * drawing's problem behind an apparently missing staircase.
 */
import { assembleStairFlights, type StairSegment } from '../mesh/stair-flight';

export interface Vec2 {
  x: number;
  y: number;
}

/** One physical step. Metres throughout, like the rest of display geometry. */
export interface StairTread {
  index: number;
  /** Centre of the tread slab, in plan. */
  centre: Vec2;
  /** Top surface of this tread, above the flight's base. */
  top: number;
  /** Along the tread — the walking width. */
  width: number;
  /** Along the run — the depth you put your foot on. */
  going: number;
  /** Thickness of the slab itself, for drawing. */
  thickness: number;
}

export interface StairHandrail {
  start: Vec2;
  end: Vec2;
  /** Height above the FIRST tread's nosing. */
  startTop: number;
  /** Height above the LAST tread's nosing. */
  endTop: number;
  side: 'left' | 'right';
}

export interface DisplayStair {
  id: string;
  layer: string;
  /** Bottom of the run, at the first riser. */
  start: Vec2;
  /** Top of the run, at the last tread's far edge. */
  end: Vec2;
  /** DEGREES from +x, pointing UP the flight. */
  directionDeg: number;
  /** Clear width, metres. */
  width: number;
  treadCount: number;
  /** One more than `treadCount` — the top riser has no tread in plan. */
  riserCount: number;
  /** Metres. */
  riser: number;
  going: number;
  totalRise: number;
  /** Horizontal distance covered, metres. */
  run: number;
  pitchDeg: number;
  treads: StairTread[];
  handrails: StairHandrail[];
  compliance: {
    ok: boolean;
    issues: Array<{ rule: string; severity: string; message: string }>;
  };
}

export interface StairFlightOptions {
  /** Metres — floor to floor. The rise is divided across the risers. */
  storeyHeight: number;
  /** Metres. Tread slab thickness, for drawing. */
  treadThickness: number;
  /** Metres above the nosing line. LIB-04 allows 865-965. */
  handrailHeight: number;
}

export const DEFAULT_STAIR_OPTIONS: StairFlightOptions = {
  storeyHeight: 3,
  treadThickness: 0.05,
  handrailHeight: 0.9,
};

export interface StairBuildResult {
  stairs: DisplayStair[];
  /** Segments that formed no flight — landing nosings, arrows, stringers. */
  orphans: number;
  warnings: string[];
}

type CheckStair = (input: {
  riserMm: number;
  goingMm: number;
  widthMm?: number;
  flightRiseMm?: number;
}) => { issues?: Array<{ rule: string; severity: string; message: string }> };

/**
 * Reconstruct staircases from the stair-layer segments of a drawing.
 *
 * `sources` are the parser's `ParsedStair` entries — one per LINE, with
 * `steps: 0` — or anything carrying `points` / `start` + `end`. Coordinates
 * are whatever unit the caller works in; `display-geometry` passes metres.
 */
export function buildStairFlights(
  sources: any[],
  checkStair: CheckStair,
  options: Partial<StairFlightOptions> = {},
): DisplayStair[] {
  return buildStairFlightsDetailed(sources, checkStair, options).stairs;
}

/** As above, but also reporting what formed no flight. */
export function buildStairFlightsDetailed(
  sources: any[],
  checkStair: CheckStair,
  options: Partial<StairFlightOptions> = {},
): StairBuildResult {
  const opts: StairFlightOptions = { ...DEFAULT_STAIR_OPTIONS, ...options };

  const segments: StairSegment[] = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const pts: any[] = Array.isArray(source?.points) ? source.points : [];
    const a = pts[0] ?? source?.start;
    const b = pts[pts.length - 1] ?? source?.end;
    if (!a || !b) continue;
    const ax = Number(a.x);
    const ay = Number(a.y);
    const bx = Number(b.x);
    const by = Number(b.y);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    if (Math.hypot(bx - ax, by - ay) <= 0) continue;
    segments.push({
      start: { x: ax, y: ay },
      end: { x: bx, y: by },
      layer: String(source?.layer ?? ''),
    });
  }

  const assembled = assembleStairFlights(segments);
  const stairs: DisplayStair[] = [];

  assembled.flights.forEach((flight, index) => {
    const ux = flight.run.x;
    const uy = flight.run.y;
    const treadCount = Math.max(1, flight.steps);
    const run = flight.runLength;
    const going = run / treadCount;

    const from: Vec2 = { x: flight.origin.x, y: flight.origin.y };
    const to: Vec2 = { x: from.x + ux * run, y: from.y + uy * run };

    // One more riser than treads — the top one lands on the floor above.
    const riserCount = treadCount + 1;
    const totalRise = opts.storeyHeight;
    const riser = totalRise / riserCount;

    const treads: StairTread[] = [];
    for (let i = 0; i < treadCount; i++) {
      // Tread i's top is at riser (i + 1): you rise BEFORE you stand on it.
      const along = going * (i + 0.5);
      treads.push({
        index: i,
        centre: { x: from.x + ux * along, y: from.y + uy * along },
        top: riser * (i + 1),
        width: flight.width,
        going,
        thickness: opts.treadThickness,
      });
    }

    const pitchDeg = (Math.atan2(riser, going) * 180) / Math.PI;

    // Handrails sit at the tread ends, parallel to the pitch line.
    const nx = -uy;
    const ny = ux;
    const half = flight.width / 2;
    const handrails: StairHandrail[] = (['left', 'right'] as const).map(
      (side) => {
        const sign = side === 'left' ? 1 : -1;
        return {
          side,
          start: { x: from.x + nx * half * sign, y: from.y + ny * half * sign },
          end: { x: to.x + nx * half * sign, y: to.y + ny * half * sign },
          startTop: riser + opts.handrailHeight,
          endTop: riser * riserCount + opts.handrailHeight,
        };
      },
    );

    // Rounded to a tenth of a millimetre before the rules are applied.
    //
    // Be precise about what this is: it is DEFENSIVE, and nothing in the test
    // fixture exercises it. Several of the standard's limits are exact values
    // a drawing commonly lands on — `going >= 280`, `riser <= 180` — and the
    // value handed to them has been through a unit scale and a median. Either
    // can land a hair under a limit the drawing exactly meets, and the report
    // would then name a violation the draughtsman cannot find.
    //
    // It was first added on the belief that the fixture's 280 going arrived as
    // 279.99999999999994. That was wrong: `0.28 * 1000` is exactly 280 in
    // IEEE doubles, and the going really being rejected came from a flight
    // that had been mis-grouped. So this guards a real class of input and is
    // NOT evidence of anything — do not count it as verified. A tenth of a
    // millimetre is far finer than any drafting tolerance, so it cannot mask
    // a genuine violation either way.
    const mm = (metres: number) => Math.round(metres * 1000 * 10) / 10;

    const report = checkStair({
      riserMm: mm(riser),
      goingMm: mm(going),
      widthMm: mm(flight.width),
      flightRiseMm: mm(totalRise),
    });
    const issues = Array.isArray(report?.issues) ? report.issues : [];

    stairs.push({
      id: `stair-flight-${index + 1}`,
      layer: flight.layer,
      start: from,
      end: to,
      directionDeg: (Math.atan2(uy, ux) * 180) / Math.PI,
      width: flight.width,
      treadCount,
      riserCount,
      riser,
      going,
      totalRise,
      run,
      pitchDeg,
      treads,
      handrails,
      compliance: {
        ok: issues.every((i) => i.severity !== 'error'),
        issues,
      },
    });
  });

  return {
    stairs,
    orphans: assembled.orphans,
    warnings: assembled.warnings,
  };
}
