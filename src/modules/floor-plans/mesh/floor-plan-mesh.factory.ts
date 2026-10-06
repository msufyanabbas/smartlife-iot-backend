// src/modules/floor-plans/mesh/floor-plan-mesh.factory.ts
//
// Turns the DXF parser's classified 2D geometry into 3D solids.
//
// The interesting part is openings. A wall is not a plain extruded box: doors
// and windows have to be CUT OUT of it, or every generated model has doors
// buried inside solid walls. Rather than a CSG boolean (expensive, fragile on
// the near-degenerate polygons CAD files produce), each wall is split along its
// centreline into the pieces that survive:
//
//   ┌──────────┬────────────┬──────────┐
//   │          │   lintel   │          │
//   │   pier   ├────────────┤   pier   │
//   │          │  OPENING   │          │
//   │          ├────────────┤          │
//   │          │    sill    │          │  ← windows only; doors reach the floor
//   └──────────┴────────────┴──────────┘
//
// Exact for the axis-aligned rectangular openings doors and windows actually
// are, at a cost of a handful of boxes per wall.

import { MeshBuilder, type Vec3 } from './mesh.builder';
import {
  cleanPolygon,
  lastUsedFanFallback,
  polygonArea,
  triangulate,
  triangulateWithHoles,
  type Vec2,
} from './triangulate';

/** Loose shape — works on freshly parsed and legacy stored geometry alike. */
export interface SourceGeometry {
  walls?: Array<any>;
  rooms?: Array<any>;
  doors?: Array<any>;
  windows?: Array<any>;
  columns?: Array<any>;
  stairs?: Array<any>;
  furniture?: Array<any>;
  building?: { floorHeight?: number };
  boundingBox?: { minX: number; minY: number; maxX: number; maxY: number };
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface BuildOptions {
  wallHeight: number;
  defaultWallThickness: number;
  slabThickness: number;
  windowSillHeight: number;
  windowHeadHeight: number;
  doorHeight: number;
  includeWalls: boolean;
  includeFloors: boolean;
  includeColumns: boolean;
  includeDoors: boolean;
  includeWindows: boolean;
  includeStairs: boolean;
  includeFurniture: boolean;
  cutOpenings: boolean;
  centerOnOrigin: boolean;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  wallHeight: 3,
  defaultWallThickness: 0.2,
  slabThickness: 0.15,
  windowSillHeight: 0.9,
  windowHeadHeight: 2.2,
  doorHeight: 2.1,
  includeWalls: true,
  includeFloors: true,
  includeColumns: true,
  includeDoors: true,
  includeWindows: true,
  includeStairs: true,
  includeFurniture: false,
  cutOpenings: true,
  centerOnOrigin: true,
};

export interface BuildResult {
  builder: MeshBuilder;
  stats: {
    walls: number;
    wallSegments: number;
    floors: number;
    columns: number;
    doors: number;
    windows: number;
    stairs: number;
    furniture: number;
    openingsCut: number;
    openingsUnmatched: number;
    triangles: number;
    vertices: number;
  };
  warnings: string[];
  boundingBox: { min: Vec3; max: Vec3; size: Vec3 };
}

interface WallOpening {
  centre: number;
  width: number;
  bottom: number;
  top: number;
  kind: 'door' | 'window';
}

/**
 * How far from a wall centreline an opening may sit and still belong to it.
 * CAD drawings rarely place a door exactly on the centreline — it is usually
 * drawn against one face — so the tolerance covers half the wall thickness plus
 * drafting slop.
 */
const OPENING_SNAP_MARGIN = 0.35;

export class FloorPlanMeshFactory {
  static build(
    geometry: SourceGeometry,
    options: Partial<BuildOptions> = {},
  ): BuildResult {
    const opts: BuildOptions = { ...DEFAULT_BUILD_OPTIONS, ...options };
    const builder = new MeshBuilder();
    const warnings: string[] = [];

    const walls = Array.isArray(geometry.walls) ? geometry.walls : [];
    const rooms = Array.isArray(geometry.rooms) ? geometry.rooms : [];
    const doors = Array.isArray(geometry.doors) ? geometry.doors : [];
    const windows = Array.isArray(geometry.windows) ? geometry.windows : [];
    const columns = Array.isArray(geometry.columns) ? geometry.columns : [];
    const stairs = Array.isArray(geometry.stairs) ? geometry.stairs : [];
    const furniture = Array.isArray(geometry.furniture) ? geometry.furniture : [];

    const wallHeight =
      Number(geometry.building?.floorHeight) > 0
        ? Number(geometry.building!.floorHeight)
        : opts.wallHeight;

    const offset = opts.centerOnOrigin
      ? this.computeCentreOffset(geometry, walls, rooms)
      : { x: 0, y: 0 };

    const stats = {
      walls: 0,
      wallSegments: 0,
      floors: 0,
      columns: 0,
      doors: 0,
      windows: 0,
      stairs: 0,
      furniture: 0,
      openingsCut: 0,
      openingsUnmatched: 0,
      triangles: 0,
      vertices: 0,
    };

    if (opts.includeFloors) {
      stats.floors = this.buildFloors(builder, rooms, offset, opts, warnings);
    }

    if (opts.includeWalls) {
      // Each opening is claimed by exactly one wall. Tracking claims lets us
      // report openings that matched nothing — the single most useful signal
      // that a drawing's layers are non-standard.
      const claimed = new Set<number>();
      const allOpenings = [
        ...doors.map((d) => ({ source: d, kind: 'door' as const })),
        ...windows.map((w) => ({ source: w, kind: 'window' as const })),
      ];

      for (const wall of walls) {
        const segment = this.wallSegment(wall);
        if (!segment) continue;

        stats.walls++;

        const thickness =
          Number(wall.thickness) > 0
            ? Number(wall.thickness)
            : opts.defaultWallThickness;
        const height = Number(wall.height) > 0 ? Number(wall.height) : wallHeight;

        const openings: WallOpening[] = [];

        if (opts.cutOpenings) {
          allOpenings.forEach((entry, index) => {
            if (claimed.has(index)) return;

            const opening = this.projectOpening(
              entry.source,
              entry.kind,
              segment,
              thickness,
              opts,
            );
            if (!opening) return;

            claimed.add(index);
            openings.push(opening);
          });
        }

        stats.wallSegments += this.buildWallWithOpenings(
          builder,
          segment,
          thickness,
          height,
          openings,
          offset,
        );
        stats.openingsCut += openings.length;
      }

      stats.openingsUnmatched = allOpenings.length - claimed.size;

      if (opts.cutOpenings && stats.openingsUnmatched > 0) {
        warnings.push(
          `${stats.openingsUnmatched} of ${allOpenings.length} openings could not be matched to a wall ` +
            'and were left uncut — they are usually drawn on a layer whose walls were not detected, ' +
            'or sit further than the snap tolerance from any wall centreline.',
        );
      }
    }

    if (opts.includeDoors) {
      for (const door of doors) {
        if (this.buildDoorLeaf(builder, door, offset, opts)) stats.doors++;
      }
    }

    if (opts.includeWindows) {
      for (const window of windows) {
        if (this.buildWindowPane(builder, window, offset, opts)) stats.windows++;
      }
    }

    if (opts.includeColumns) {
      for (const column of columns) {
        const position = this.point(column.position);
        if (!position) continue;

        const width = Number(column.width) > 0 ? Number(column.width) : 0.4;
        const footprint = Number(column.height) > 0 ? Number(column.height) : width;
        const extrusion = Number(column.depth) > 0 ? Number(column.depth) : wallHeight;

        builder.addBox(
          'column',
          { x: position.x + offset.x, y: position.y + offset.y, z: 0 },
          { x: 1, y: 0 },
          footprint,
          width,
          extrusion,
        );
        stats.columns++;
      }
    }

    if (opts.includeStairs) {
      for (const stair of stairs) {
        if (this.buildStair(builder, stair, offset, wallHeight)) stats.stairs++;
      }
    }

    if (opts.includeFurniture) {
      for (const item of furniture) {
        const position = this.point(item.position);
        if (!position) continue;

        const d = item.dimensions ?? {};
        const width = Number(d.width) > 0 ? Number(d.width) : 0.6;
        const depth = Number(d.depth) > 0 ? Number(d.depth) : 0.6;
        const height = Number(d.height) > 0 ? Number(d.height) : 0.75;
        const rotation = ((Number(item.rotation) || 0) * Math.PI) / 180;

        builder.addBox(
          'furniture',
          { x: position.x + offset.x, y: position.y + offset.y, z: 0 },
          { x: Math.cos(rotation), y: Math.sin(rotation) },
          depth,
          width,
          height,
        );
        stats.furniture++;
      }
    }

    stats.triangles = builder.triangleCount;
    stats.vertices = builder.vertexCount;

    if (builder.isEmpty()) {
      warnings.push(
        'No 3D geometry was produced. The drawing parsed but contained no walls, rooms or columns ' +
          'to extrude — check that the source file uses recognisable layer names.',
      );
    }

    return { builder, stats, warnings, boundingBox: this.measure(builder) };
  }

  // ── Walls ────────────────────────────────────────────────────────────────

  private static wallSegment(
    wall: any,
  ): { start: Vec2; end: Vec2; dx: number; dy: number; length: number } | null {
    let start = this.point(wall?.start);
    let end = this.point(wall?.end);

    // Legacy shape: a `points` array rather than start/end.
    if ((!start || !end) && Array.isArray(wall?.points) && wall.points.length >= 2) {
      start = this.point(wall.points[0]);
      end = this.point(wall.points[wall.points.length - 1]);
    }

    if (!start || !end) return null;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);

    if (length < 1e-6) return null;

    return { start, end, dx, dy, length };
  }

  /**
   * Projects a door or window onto a wall's local axis.
   *
   * Returns null when it does not belong to this wall: too far from the
   * centreline, OR its projection falls outside the wall's extent. Both checks
   * matter — without the second, a door at the far end of a corridor would be
   * cut into every wall collinear with it.
   */
  private static projectOpening(
    source: any,
    kind: 'door' | 'window',
    segment: { start: Vec2; dx: number; dy: number; length: number },
    wallThickness: number,
    opts: BuildOptions,
  ): WallOpening | null {
    const start = this.point(source?.start);
    const end = this.point(source?.end);
    const position =
      this.point(source?.position) ??
      (start && end ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : null);

    if (!position) return null;

    const ux = segment.dx / segment.length;
    const uy = segment.dy / segment.length;

    const relX = position.x - segment.start.x;
    const relY = position.y - segment.start.y;

    const along = relX * ux + relY * uy;
    const perpendicular = Math.abs(relX * -uy + relY * ux);

    if (perpendicular > wallThickness / 2 + OPENING_SNAP_MARGIN) return null;

    const width = Number(source?.width) > 0 ? Number(source.width) : 0.9;

    // Must actually overlap the wall, not merely be collinear. Half a width of
    // overhang is allowed for a door drawn at a wall end.
    if (along < -width / 2 || along > segment.length + width / 2) return null;

    if (kind === 'door') {
      const height = Number(source?.height) > 0 ? Number(source.height) : opts.doorHeight;
      return { centre: along, width, bottom: 0, top: height, kind };
    }

    const sill =
      Number(source?.sillHeight) >= 0
        ? Number(source.sillHeight)
        : opts.windowSillHeight;
    const head =
      Number(source?.height) > 0 ? sill + Number(source.height) : opts.windowHeadHeight;

    return { centre: along, width, bottom: sill, top: Math.max(head, sill + 0.1), kind };
  }

  /** @returns the number of solid boxes emitted. */
  private static buildWallWithOpenings(
    builder: MeshBuilder,
    segment: { start: Vec2; dx: number; dy: number; length: number },
    thickness: number,
    height: number,
    openings: WallOpening[],
    offset: Vec2,
  ): number {
    const ux = segment.dx / segment.length;
    const uy = segment.dy / segment.length;

    const emit = (from: number, to: number, bottom: number, top: number) => {
      const length = to - from;
      const boxHeight = top - bottom;
      if (length <= 1e-6 || boxHeight <= 1e-6) return 0;

      const mid = (from + to) / 2;
      builder.addBox(
        'wall',
        {
          x: segment.start.x + ux * mid + offset.x,
          y: segment.start.y + uy * mid + offset.y,
          z: bottom,
        },
        { x: ux, y: uy },
        length,
        thickness,
        boxHeight,
      );
      return 1;
    };

    if (openings.length === 0) return emit(0, segment.length, 0, height);

    // Clamped and sorted so overlapping openings merge predictably rather than
    // producing inverted spans.
    const spans = openings
      .map((o) => ({
        from: Math.max(0, o.centre - o.width / 2),
        to: Math.min(segment.length, o.centre + o.width / 2),
        bottom: Math.max(0, o.bottom),
        top: Math.min(height, o.top),
      }))
      .filter((s) => s.to > s.from && s.top > s.bottom)
      .sort((a, b) => a.from - b.from);

    let emitted = 0;
    let cursor = 0;

    for (const span of spans) {
      if (span.from > cursor) emitted += emit(cursor, span.from, 0, height);
      if (span.bottom > 0) emitted += emit(span.from, span.to, 0, span.bottom);
      if (span.top < height) emitted += emit(span.from, span.to, span.top, height);
      cursor = Math.max(cursor, span.to);
    }

    if (cursor < segment.length) emitted += emit(cursor, segment.length, 0, height);

    return emitted;
  }

  // ── Floors ───────────────────────────────────────────────────────────────

  private static buildFloors(
    builder: MeshBuilder,
    rooms: any[],
    offset: Vec2,
    opts: BuildOptions,
    warnings: string[],
  ): number {
    let built = 0;
    let skipped = 0;
    let degradedHoles = 0;

    // Largest first, so a room fully inside another is treated as a hole rather
    // than overlapping z-fighting geometry.
    const polygons = rooms
      .map((room) => {
        const raw = Array.isArray(room?.vertices)
          ? room.vertices
          : Array.isArray(room?.boundaries)
            ? room.boundaries
            : [];
        const points = cleanPolygon(
          raw
            .map((p: any) => this.point(p))
            .filter((p: Vec2 | null): p is Vec2 => p !== null),
        );
        return { points, area: points.length >= 3 ? polygonArea(points) : 0 };
      })
      .filter((entry) => entry.points.length >= 3 && entry.area > 1e-6)
      .sort((a, b) => b.area - a.area);

    const consumedAsHole = new Set<number>();

    polygons.forEach((polygon, index) => {
      if (consumedAsHole.has(index)) return;

      const holes: Vec2[][] = [];
      for (let j = index + 1; j < polygons.length; j++) {
        if (consumedAsHole.has(j)) continue;
        if (this.polygonContains(polygon.points, polygons[j].points)) {
          holes.push(polygons[j].points);
          consumedAsHole.add(j);
        }
      }

      const shifted = polygon.points.map((p) => ({
        x: p.x + offset.x,
        y: p.y + offset.y,
      }));

      if (holes.length > 0) {
        const shiftedHoles = holes.map((hole) =>
          hole.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
        );
        const { vertices, triangles } = triangulateWithHoles(shifted, shiftedHoles);
        if (triangles.length === 0) {
          skipped++;
          return;
        }
        // The fan fallback fills the whole outline and ignores holes, so a slab
        // that hit it is not merely rougher — its cut-outs are missing.
        if (lastUsedFanFallback()) degradedHoles++;

        builder.addExtrudedPolygon(
          'floor',
          vertices,
          triangles,
          -opts.slabThickness,
          opts.slabThickness,
        );
      } else {
        const triangles = triangulate(shifted);
        if (triangles.length === 0) {
          skipped++;
          return;
        }
        builder.addExtrudedPolygon(
          'floor',
          shifted,
          triangles,
          -opts.slabThickness,
          opts.slabThickness,
        );
      }

      built++;
    });

    if (skipped > 0) {
      warnings.push(
        `${skipped} room polygon(s) could not be triangulated and were skipped — ` +
          'they are usually self-intersecting boundaries in the source drawing.',
      );
    }

    if (degradedHoles > 0) {
      warnings.push(
        `${degradedHoles} floor slab(s) with interior cut-outs fell back to a simple fill, ` +
          'so their holes (lift shafts, atria) are solid in the generated model.',
      );
    }

    return built;
  }

  private static polygonContains(outer: Vec2[], inner: Vec2[]): boolean {
    return inner.every((point) => this.pointInPolygon(point, outer));
  }

  private static pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const intersects =
        polygon[i].y > point.y !== polygon[j].y > point.y &&
        point.x <
          ((polygon[j].x - polygon[i].x) * (point.y - polygon[i].y)) /
            (polygon[j].y - polygon[i].y) +
            polygon[i].x;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  // ── Doors, windows, stairs ───────────────────────────────────────────────

  private static buildDoorLeaf(
    builder: MeshBuilder,
    door: any,
    offset: Vec2,
    opts: BuildOptions,
  ): boolean {
    const position = this.point(door?.position);
    if (!position) return false;

    const width = Number(door?.width) > 0 ? Number(door.width) : 0.9;
    const height = Number(door?.height) > 0 ? Number(door.height) : opts.doorHeight;
    const angle = ((Number(door?.angle ?? door?.rotation) || 0) * Math.PI) / 180;

    // A thin panel filling the opening. Leaf thickness is nominal — the
    // interesting geometry is the hole in the wall, not the door itself.
    builder.addBox(
      'door',
      { x: position.x + offset.x, y: position.y + offset.y, z: 0 },
      { x: Math.cos(angle), y: Math.sin(angle) },
      width,
      0.05,
      height,
    );

    return true;
  }

  private static buildWindowPane(
    builder: MeshBuilder,
    window: any,
    offset: Vec2,
    opts: BuildOptions,
  ): boolean {
    const start = this.point(window?.start);
    const end = this.point(window?.end);
    const position =
      this.point(window?.position) ??
      (start && end ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : null);

    if (!position) return false;

    let width = Number(window?.width) > 0 ? Number(window.width) : 0;
    let ux = 1;
    let uy = 0;

    if (start && end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        ux = dx / length;
        uy = dy / length;
        if (width <= 0) width = length;
      }
    } else {
      const angle = ((Number(window?.rotation) || 0) * Math.PI) / 180;
      ux = Math.cos(angle);
      uy = Math.sin(angle);
    }

    if (width <= 0) width = 1.2;

    const sill =
      Number(window?.sillHeight) >= 0
        ? Number(window.sillHeight)
        : opts.windowSillHeight;
    const paneHeight =
      Number(window?.height) > 0
        ? Number(window.height)
        : Math.max(0.1, opts.windowHeadHeight - sill);

    builder.addBox(
      'window',
      { x: position.x + offset.x, y: position.y + offset.y, z: sill },
      { x: ux, y: uy },
      width,
      0.03,
      paneHeight,
    );

    return true;
  }

  /** A run of discrete steps rather than a ramp, so step count stays meaningful. */
  private static buildStair(
    builder: MeshBuilder,
    stair: any,
    offset: Vec2,
    floorHeight: number,
  ): boolean {
    const points = Array.isArray(stair?.points)
      ? stair.points
          .map((p: any) => this.point(p))
          .filter((p: Vec2 | null): p is Vec2 => p !== null)
      : [];

    const start = points[0] ?? this.point(stair?.position);
    const end = points[points.length - 1] ?? null;

    if (!start) return false;

    const steps = Math.max(2, Math.min(60, Number(stair?.steps) || 16));
    const width = Number(stair?.width) > 0 ? Number(stair.width) : 1.2;

    let ux = 1;
    let uy = 0;
    let run = steps * 0.28;

    if (end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        ux = dx / length;
        uy = dy / length;
        run = length;
      }
    }

    const tread = run / steps;
    const riser = floorHeight / steps;

    for (let i = 0; i < steps; i++) {
      const distance = tread * (i + 0.5);
      builder.addBox(
        'stair',
        {
          x: start.x + ux * distance + offset.x,
          y: start.y + uy * distance + offset.y,
          z: 0,
        },
        { x: ux, y: uy },
        tread,
        width,
        riser * (i + 1),
      );
    }

    return true;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Coerces a loosely typed point, rejecting NaN and missing coordinates. */
  private static point(value: any): Vec2 | null {
    if (!value) return null;
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  private static computeCentreOffset(
    geometry: SourceGeometry,
    walls: any[],
    rooms: any[],
  ): Vec2 {
    const box = geometry.boundingBox ?? geometry.bounds;

    if (box && Number.isFinite(box.minX) && Number.isFinite(box.maxX) && box.maxX > box.minX) {
      return { x: -(box.minX + box.maxX) / 2, y: -(box.minY + box.maxY) / 2 };
    }

    // No usable bounding box — derive one. Legacy rows hit this.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const consider = (p: Vec2 | null) => {
      if (!p) return;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    };

    for (const wall of walls) {
      const segment = this.wallSegment(wall);
      if (segment) {
        consider(segment.start);
        consider(segment.end);
      }
    }
    for (const room of rooms) {
      const raw = Array.isArray(room?.vertices) ? room.vertices : room?.boundaries;
      if (Array.isArray(raw)) raw.forEach((p: any) => consider(this.point(p)));
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return { x: 0, y: 0 };

    return { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 };
  }

  private static measure(builder: MeshBuilder): BuildResult['boundingBox'] {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (const group of builder.getGroups()) {
      for (let i = 0; i < group.positions.length; i += 3) {
        const x = group.positions[i];
        const y = group.positions[i + 1];
        const z = group.positions[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    if (!Number.isFinite(minX)) {
      const zero = { x: 0, y: 0, z: 0 };
      return { min: zero, max: zero, size: zero };
    }

    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    };
  }
}
