// src/modules/floor-plans/mesh/triangulate.ts
//
// Ear-clipping triangulation for the room polygons the DXF parser produces.
//
// Hand-rolled rather than using `earcut`: adding a dependency would mean every
// deploy target reinstalls before it can build, and these polygons are small
// (tens of vertices) and always simple. Ear clipping is O(n²), irrelevant here.

export interface Vec2 {
  x: number;
  y: number;
}

const EPSILON = 1e-12;

/**
 * Set when the last triangulate() gave up on ear clipping and fanned instead.
 * A fan ignores holes, so a caller that bridged holes needs to know the result
 * is wrong rather than merely rough.
 */
let fanFallbackUsed = false;

export function lastUsedFanFallback(): boolean {
  return fanFallbackUsed;
}

/** Doubled signed area. Positive means counter-clockwise. */
export function signedArea(polygon: Vec2[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += (polygon[j].x - polygon[i].x) * (polygon[j].y + polygon[i].y);
  }
  return sum / 2;
}

export function polygonArea(polygon: Vec2[]): number {
  return Math.abs(signedArea(polygon));
}

/** Removes consecutive duplicates and a repeated closing vertex. */
export function cleanPolygon(polygon: Vec2[], tolerance = 1e-9): Vec2[] {
  const out: Vec2[] = [];

  for (const point of polygon) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.x - point.x) < tolerance &&
      Math.abs(last.y - point.y) < tolerance
    ) {
      continue;
    }
    out.push(point);
  }

  // DXF polylines frequently repeat the first vertex to close the loop.
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.x - last.x) < tolerance &&
      Math.abs(first.y - last.y) < tolerance
    ) {
      out.pop();
    } else {
      break;
    }
  }

  return out;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Two vertices at (near enough) the same place — see the ear test. */
function coincident(a: Vec2, b: Vec2, tolerance = 1e-9): boolean {
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);

  const hasNeg = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
  const hasPos = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;

  // On-edge counts as inside, which is what stops us clipping an ear that
  // touches another vertex.
  return !(hasNeg && hasPos);
}

/**
 * Triangulates a simple polygon by ear clipping.
 * Returns flat index triples into the cleaned input.
 */
export function triangulate(polygon: Vec2[]): number[] {
  fanFallbackUsed = false;

  const cleaned = cleanPolygon(polygon);
  if (cleaned.length < 3) return [];

  const indices: number[] = cleaned.map((_, i) => i);

  // Ear clipping assumes CCW; reverse a CW polygon.
  if (signedArea(cleaned) < 0) indices.reverse();

  const triangles: number[] = [];
  let guard = indices.length * indices.length;

  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i - 1 + indices.length) % indices.length];
      const curr = indices[i];
      const next = indices[(i + 1) % indices.length];

      const a = cleaned[prev];
      const b = cleaned[curr];
      const c = cleaned[next];

      // Reflex vertex — not an ear.
      if (cross(a, b, c) <= EPSILON) continue;

      // An ear must contain no other vertex.
      //
      // Compared by POSITION, not index. Hole bridging deliberately creates
      // duplicate vertices (the bridge edge is walked twice), and since
      // pointInTriangle counts on-boundary as inside, comparing by index alone
      // rejected every candidate ear — the triangulator then fell through to its
      // fan fallback, which ignores holes and fills them in.
      let containsOther = false;
      for (const other of indices) {
        if (other === prev || other === curr || other === next) continue;

        const p = cleaned[other];
        if (coincident(p, a) || coincident(p, b) || coincident(p, c)) continue;

        if (pointInTriangle(p, a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      triangles.push(prev, curr, next);
      indices.splice(i, 1);
      clipped = true;
      break;
    }

    // No ear found — self-intersecting or degenerate. A fan is a far better
    // fallback than emitting nothing for a slightly dirty CAD boundary, but it
    // does NOT respect holes, so the flag lets callers report that.
    if (!clipped) {
      fanFallbackUsed = true;
      for (let i = 1; i < indices.length - 1; i++) {
        triangles.push(indices[0], indices[i], indices[i + 1]);
      }
      return triangles;
    }
  }

  if (indices.length === 3) {
    triangles.push(indices[0], indices[1], indices[2]);
  }

  return triangles;
}

/**
 * Triangulates an outer polygon with holes cut out.
 *
 * Each hole is joined to the outer ring by a doubled "bridge" edge, producing a
 * single simple polygon ordinary ear clipping can handle.
 */
export function triangulateWithHoles(
  outer: Vec2[],
  holes: Vec2[][],
): { vertices: Vec2[]; triangles: number[] } {
  const cleanedOuter = cleanPolygon(outer);
  if (cleanedOuter.length < 3) return { vertices: [], triangles: [] };

  const usableHoles = holes
    .map((hole) => cleanPolygon(hole))
    .filter((hole) => hole.length >= 3);

  if (usableHoles.length === 0) {
    return { vertices: cleanedOuter, triangles: triangulate(cleanedOuter) };
  }

  // Outer CCW, holes CW — the winding is what makes the bridge produce a
  // correctly oriented single loop.
  let ring =
    signedArea(cleanedOuter) < 0 ? [...cleanedOuter].reverse() : [...cleanedOuter];

  const orderedHoles = usableHoles
    .map((hole) => (signedArea(hole) > 0 ? [...hole].reverse() : hole))
    // Rightmost first: bridging the hole nearest the outer edge first keeps
    // later bridges from crossing an earlier one.
    .sort((a, b) => Math.max(...b.map((p) => p.x)) - Math.max(...a.map((p) => p.x)));

  for (const hole of orderedHoles) {
    // The rightmost vertex is on the hole's convex hull, so a ray from it exits
    // the hole immediately.
    let holeStart = 0;
    for (let i = 1; i < hole.length; i++) {
      if (hole[i].x > hole[holeStart].x) holeStart = i;
    }

    // Nearest outer vertex, as a practical stand-in for full visibility
    // testing — for near-convex room outlines the closest vertex is visible.
    let bridgeIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const dx = ring[i].x - hole[holeStart].x;
      const dy = ring[i].y - hole[holeStart].y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bridgeIndex = i;
      }
    }

    const rotatedHole = [
      ...hole.slice(holeStart),
      ...hole.slice(0, holeStart),
      hole[holeStart],
    ];

    ring = [
      ...ring.slice(0, bridgeIndex + 1),
      ...rotatedHole,
      ...ring.slice(bridgeIndex),
    ];
  }

  return { vertices: ring, triangles: triangulate(ring) };
}
