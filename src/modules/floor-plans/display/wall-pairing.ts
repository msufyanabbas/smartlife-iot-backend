/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Pair the two drawn FACES of a wall into one wall of real thickness
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the step that was missing, and it is the reason imported models
 * looked wrong in two different ways at once.
 *
 * An architect does not draw a wall. They draw its two faces:
 *
 *        ────────────────────────────────  ← outer face   (one LINE)
 *        ────────────────────────────────  ← inner face   (another LINE)
 *                                             200 mm apart
 *
 * The importer treated every line as a wall in its own right, and
 * `DxfFloorPlanParser.makeWall()` has no way to know a width — a single DXF
 * LINE has no thickness — so it stamped every one with `thickness: 0.1`. A
 * 12 × 8 m room with 200 mm walls therefore imported as **eight** 100 mm walls
 * standing in four pairs with a 100 mm slot of empty space running between
 * them, instead of four 200 mm walls.
 *
 * That single defect produced both symptoms the client reported:
 *
 *   · "there is an issue in creating the lines as walls" — doubled, too-thin
 *     walls with gaps between them, which is what the slot looks like in 3D.
 *   · "the thickness feature has no benefit" — every wall reported 0.1 m
 *     whatever the drawing said, so the real thickness was never available to
 *     show. (The viewer then clamped that 0.1 into its own slider range and
 *     overrode the user's choice with it — see the frontend fix.)
 *
 * ── The algorithm ──────────────────────────────────────────────────────────
 *
 * Two segments are the faces of one wall when all four hold:
 *
 *   1. They are PARALLEL within `angleToleranceDeg`. Faces of one wall are
 *      drawn parallel; a corner is not.
 *   2. Their perpendicular separation is within [minThickness, maxThickness].
 *      Below the floor it is a doubled line or a hatch; above the ceiling they
 *      are two different walls across a corridor, and fusing those would
 *      swallow the corridor.
 *   3. They OVERLAP when projected onto their shared direction, by at least
 *      `minOverlapRatio` of the shorter one. Two short jambs on the same line
 *      either side of a door are collinear but do not overlap, and must stay
 *      separate.
 *   4. Neither is already claimed. Each face belongs to exactly one wall.
 *
 * Greedy, nearest-first: every candidate pair is scored and the closest
 * separation wins, so a 100 mm partition beside a 300 mm wall pairs with its
 * own other face rather than with its neighbour's.
 *
 * The result is the CENTRELINE — the mean of the two faces — carrying the
 * measured separation as its thickness. That is what a wall is: a centreline
 * and a width.
 *
 * ── What is deliberately NOT done ──────────────────────────────────────────
 *
 * An unpaired line stays a wall, at the default thickness, flagged
 * `thicknessSource: 'default'`. Dropping it would delete every genuinely
 * single-line wall — a drawn-thin partition, a site boundary, a wall whose
 * other face is on a layer that was filtered out — and a missing wall is
 * harder to notice than a slightly wrong one. The flag is what lets the viewer
 * tell "the drawing says 200 mm" from "nobody knows, here is a default",
 * which is the distinction its thickness control needs in order to mean
 * anything.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface PairableWall {
  id: string;
  start: { x: number; y: number; z?: number };
  end: { x: number; y: number; z?: number };
  thickness?: number;
  height?: number;
  layer?: string;
  [key: string]: any;
}

export interface PairedWall {
  id: string;
  start: Vec2;
  end: Vec2;
  /** Metres. Measured from the drawing when `thicknessSource` is `paired`. */
  thickness: number;
  height: number;
  layer: string;
  /**
   * Where the thickness came from. `paired` means it was measured between two
   * drawn faces and is real; `default` means the drawing did not say and a
   * fallback was used, so a viewer may legitimately override it.
   */
  thicknessSource: 'paired' | 'default' | 'drawing';
  /** The ids of the source face lines, for tracing back to the drawing. */
  faceIds: string[];
}

export interface PairingOptions {
  /** Metres. Below this, two lines are a doubled line or a hatch, not a wall. */
  minThickness: number;
  /** Metres. Above this they are two walls across a gap, not one wall. */
  maxThickness: number;
  /** Degrees of misalignment still counted as parallel. */
  angleToleranceDeg: number;
  /** Fraction of the shorter segment that must overlap the longer one. */
  minOverlapRatio: number;
  /** Metres. Applied to a line that could not be paired. */
  defaultThickness: number;
}

export const DEFAULT_PAIRING: PairingOptions = {
  // 50 mm: thinner than any real wall, so a doubled line cannot masquerade as
  // one. Hatch lines inside a wall sit much closer than this.
  minThickness: 0.05,
  // 600 mm: covers a 450 mm cavity wall and a 500 mm structural core. A metre
  // apart is a corridor, and pairing those would fill it in.
  maxThickness: 0.6,
  // 2°: CAD walls are drawn exactly parallel, but coordinates arrive through a
  // unit conversion and a float, and a long wall amplifies a rounding error
  // into a visible angle.
  angleToleranceDeg: 2,
  // Half the shorter face. A door splits one face into two jambs while the
  // other face runs past unbroken, so partial overlap is normal; a tenth
  // would start pairing a jamb with the wall across the room.
  minOverlapRatio: 0.5,
  defaultThickness: 0.1,
};

interface Segment {
  index: number;
  source: PairableWall;
  a: Vec2;
  b: Vec2;
  /** Unit direction. */
  ux: number;
  uy: number;
  length: number;
}

const EPSILON = 1e-9;

function toSegment(source: PairableWall, index: number): Segment | null {
  const a = { x: Number(source?.start?.x), y: Number(source?.start?.y) };
  const b = { x: Number(source?.end?.x), y: Number(source?.end?.y) };
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return null;

  return { index, source, a, b, ux: dx / length, uy: dy / length, length };
}

/**
 * How far segment `other` is from the infinite line through `base`, and how
 * much of the two overlaps along `base`'s direction.
 *
 * Returns null when they are not parallel. The perpendicular distance is taken
 * at both endpoints and averaged: for genuinely parallel lines the two agree,
 * and averaging removes the asymmetry that would otherwise make pairing depend
 * on which line happened to be considered first.
 */
function relate(
  base: Segment,
  other: Segment,
  angleToleranceDeg: number,
): { separation: number; overlap: number } | null {
  // |cross| of two unit vectors is |sin(angle)|. Parallel and anti-parallel
  // are both acceptable: the two faces of a wall are frequently drawn in
  // opposite directions, which is why this is an absolute value.
  const sinAngle = Math.abs(base.ux * other.uy - base.uy * other.ux);
  if (sinAngle > Math.sin((angleToleranceDeg * Math.PI) / 180)) return null;

  const perpOf = (p: Vec2) => {
    const rx = p.x - base.a.x;
    const ry = p.y - base.a.y;
    // Perpendicular component: the cross product with the unit direction.
    return rx * -base.uy + ry * base.ux;
  };
  const alongOf = (p: Vec2) => {
    const rx = p.x - base.a.x;
    const ry = p.y - base.a.y;
    return rx * base.ux + ry * base.uy;
  };

  const p1 = perpOf(other.a);
  const p2 = perpOf(other.b);

  // Opposite signs mean the other segment CROSSES this line rather than
  // running alongside it. Crossing faces are not a wall, they are a junction.
  if (Math.sign(p1) !== Math.sign(p2) && Math.abs(p1) > EPSILON && Math.abs(p2) > EPSILON) {
    return null;
  }

  const separation = (Math.abs(p1) + Math.abs(p2)) / 2;

  const s1 = alongOf(other.a);
  const s2 = alongOf(other.b);
  const otherMin = Math.min(s1, s2);
  const otherMax = Math.max(s1, s2);

  const overlap = Math.min(base.length, otherMax) - Math.max(0, otherMin);

  return { separation, overlap };
}

export interface PairingResult {
  walls: PairedWall[];
  /** How many walls were formed by pairing two drawn faces. */
  paired: number;
  /** How many lines could not be paired and kept the default thickness. */
  unpaired: number;
}

export function pairWallFaces(
  input: PairableWall[],
  options: Partial<PairingOptions> = {},
): PairingResult {
  const opts: PairingOptions = { ...DEFAULT_PAIRING, ...options };

  const segments: Segment[] = [];
  input.forEach((source, i) => {
    const s = toSegment(source, i);
    if (s) segments.push(s);
  });

  // ── Score every candidate pair ──────────────────────────────────────────
  //
  // O(n²) on the wall candidates of one floor, which is hundreds — and it runs
  // once per import, not per request. A spatial index would be the answer if
  // this ever moved onto a hot path.
  interface Candidate {
    i: number;
    j: number;
    separation: number;
    overlap: number;
  }
  const candidates: Candidate[] = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i];
      const b = segments[j];

      // Faces of one wall are on the same layer. Pairing across layers would
      // fuse a partition face to an external wall face, and the layer is the
      // only statement of intent the drawing makes.
      if ((a.source.layer ?? '') !== (b.source.layer ?? '')) continue;

      const rel = relate(a, b, opts.angleToleranceDeg);
      if (!rel) continue;
      if (rel.separation < opts.minThickness || rel.separation > opts.maxThickness) continue;

      const shorter = Math.min(a.length, b.length);
      if (rel.overlap < shorter * opts.minOverlapRatio) continue;

      candidates.push({ i, j, separation: rel.separation, overlap: rel.overlap });
    }
  }

  // Nearest separation first, then longest overlap. A wall pairs with its own
  // other face before it pairs with anything across a gap.
  candidates.sort(
    (p, q) => p.separation - q.separation || q.overlap - p.overlap,
  );

  const claimed = new Set<number>();
  const walls: PairedWall[] = [];
  let paired = 0;

  for (const c of candidates) {
    if (claimed.has(c.i) || claimed.has(c.j)) continue;
    claimed.add(c.i);
    claimed.add(c.j);

    const a = segments[c.i];
    const b = segments[c.j];

    // ── The centreline ────────────────────────────────────────────────────
    //
    // Projecting B's endpoints onto A's direction before averaging is what
    // makes this correct when the two faces are drawn with different extents
    // or in opposite directions — which is the normal case, not the exception.
    // Averaging raw endpoints pairwise would produce a diagonal centreline for
    // two anti-parallel faces.
    const alongOf = (p: Vec2) =>
      (p.x - a.a.x) * a.ux + (p.y - a.a.y) * a.uy;

    const bStart = alongOf(b.a);
    const bEnd = alongOf(b.b);
    const bMin = Math.min(bStart, bEnd);
    const bMax = Math.max(bStart, bEnd);

    // The wall runs the full extent the two faces jointly describe.
    const lo = Math.min(0, bMin);
    const hi = Math.max(a.length, bMax);

    // Midpoint between the two faces, found by stepping half the separation
    // along A's normal, in the direction B actually lies.
    const sideSign = Math.sign(
      (b.a.x - a.a.x) * -a.uy + (b.a.y - a.a.y) * a.ux,
    ) || 1;
    const half = (c.separation / 2) * sideSign;
    const nx = -a.uy * half;
    const ny = a.ux * half;

    walls.push({
      id: `${a.source.id ?? `w${c.i}`}+${b.source.id ?? `w${c.j}`}`,
      start: { x: a.a.x + a.ux * lo + nx, y: a.a.y + a.uy * lo + ny },
      end: { x: a.a.x + a.ux * hi + nx, y: a.a.y + a.uy * hi + ny },
      thickness: c.separation,
      height: Math.max(Number(a.source.height) || 0, Number(b.source.height) || 0) || 3,
      layer: a.source.layer ?? b.source.layer ?? '',
      thicknessSource: 'paired',
      faceIds: [String(a.source.id ?? c.i), String(b.source.id ?? c.j)],
    });
    paired++;
  }

  // ── Everything that did not pair stays a wall ───────────────────────────
  let unpaired = 0;
  for (const s of segments) {
    if (claimed.has(s.index)) continue;
    unpaired++;

    // A thickness the parser actually took from the drawing is respected; the
    // 0.1 it stamps on every line is not, and is reported as the default it
    // is. `makeWall()` has no source for a width, so in practice this is
    // always the default today — the field exists so that a future parser
    // that CAN read one does not have to change this file.
    const declared = Number(s.source.thickness);
    const isRealDeclaration =
      Number.isFinite(declared) &&
      declared > 0 &&
      Math.abs(declared - DEFAULT_PAIRING.defaultThickness) > 1e-6;

    walls.push({
      id: String(s.source.id ?? `w${s.index}`),
      start: s.a,
      end: s.b,
      thickness: isRealDeclaration ? declared : opts.defaultThickness,
      height: Number(s.source.height) > 0 ? Number(s.source.height) : 3,
      layer: s.source.layer ?? '',
      thicknessSource: isRealDeclaration ? 'drawing' : 'default',
      faceIds: [String(s.source.id ?? s.index)],
    });
  }

  return { walls, paired, unpaired };
}
