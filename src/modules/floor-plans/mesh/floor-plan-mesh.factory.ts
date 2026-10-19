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
  applyCadStandard,
  describeDropped,
} from './cad-standard.filter';
import { CadStandardsService } from '@modules/cad-standards/cad-standards.service';
import {
  assembleStairFlights,
  type StairFlight,
  type StairSegment,
} from './stair-flight';
import type { MountPlane } from '@modules/cad-standards/cad-standard.catalogue';
import {
  cleanPolygon,
  lastUsedFanFallback,
  polygonArea,
  triangulate,
  triangulateWithHoles,
  type Vec2,
} from './triangulate';

/**
 * A pure function over a constant table — no repositories, no config, no
 * other services — so instantiating one here duplicates no state. Same
 * reasoning as `cad-standard.bridge.ts`: the alternative is re-implementing
 * the lookup, which is how two copies of a rule table drift apart.
 */
const standards = new CadStandardsService();

/** Loose shape — works on freshly parsed and legacy stored geometry alike. */
export interface SourceGeometry {
  walls?: Array<any>;
  rooms?: Array<any>;
  doors?: Array<any>;
  windows?: Array<any>;
  columns?: Array<any>;
  stairs?: Array<any>;
  furniture?: Array<any>;
  devices?: Array<any>;
  routes?: Array<any>;
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
  /**
   * Equipment from `marker` layers — luminaires, cameras, sockets, detectors,
   * sprinkler heads, panels, racks.
   *
   * On by default. These are genuinely present in the building and the
   * drawing says exactly where they are; leaving them out produces a bare
   * shell from a plan that was full of information.
   */
  includeDevices: boolean;
  /** Service runs from `route` layers — cable tray, conduit, duct, pipe. */
  includeRoutes: boolean;
  /** The ceiling plane from A-CLNG, built at ceiling height. */
  includeCeilings: boolean;
  /** Beams from S-BEAM, built at the soffit rather than on the floor. */
  includeBeams: boolean;
  cutOpenings: boolean;
  centerOnOrigin: boolean;
  /**
   * Classify every layer against the CAD drawing standard and exclude the
   * geometry that is drawn but not built. On by default: a plan extruded
   * without it grows walls where the grid and the dimension strings were.
   */
  enforceCadStandard: boolean;
  /** Build geometry on layers the standard does not describe. */
  keepUnrecognisedLayers: boolean;
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
  includeDevices: true,
  includeRoutes: true,
  includeCeilings: false, // hides the floor below it when viewed from above
  includeBeams: true,
  cutOpenings: true,
  centerOnOrigin: true,
  enforceCadStandard: true,
  keepUnrecognisedLayers: false,
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
    /** Treads across all assembled flights — stairs counts the flights. */
    stairTreads: number;
    furniture: number;
    /** Equipment placements built from `marker` layers. */
    devices: number;
    /** Service runs built from `route` layers. */
    routes: number;
    beams: number;
    ceilingMembers: number;
    /**
     * Elevated geometry that was neither beam nor ceiling. Should be 0; a
     * non-zero value means a layer is arriving here unrecognised, which is
     * how 65 stair treads were once silently counted as ceiling grid.
     */
    elevatedOther: number;
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
  /**
   * Resolve a layer's mounting rule into a Z for the bottom of the solid.
   *
   * `mountMm` is an offset from a named plane rather than an absolute height,
   * because the same rule has to work in a 3 m office and a 6 m warehouse. A
   * ceiling camera is "150 below the ceiling" in both; stored as an absolute
   * 2550 it would be stranded mid-air in the warehouse.
   *
   * `height` is needed for the ceiling case: a device hangs from the ceiling
   * by its TOP, so the box's base sits a further `height` down. Without it
   * every ceiling device would be embedded in the slab with its body poking
   * up into the floor above.
   */
  private static mountHeight(
    rule: { mount?: MountPlane; mountMm?: number },
    ceilingHeight: number,
    height: number,
    /**
     * Structural storey height. Given, the result is clamped so nothing is
     * modelled through the floor above: the catalogue's offsets are budgeted
     * for a 450 mm void, and a drawing with a 2.4 m storey has far less. The
     * clamp squeezes the run into the void it actually has rather than
     * letting a 400 mm duct emerge in the storey above.
     */
    storeyHeight?: number,
  ): number {
    const offset = (rule.mountMm ?? 0) / 1000;

    let z: number;
    switch (rule.mount) {
      case 'ceiling':
        z = ceilingHeight - offset - height;
        break;
      case 'soffit':
        z = ceilingHeight + offset;
        break;
      case 'wall':
      case 'floor':
        z = offset;
        break;
      default:
        // No rule: sit it on the floor. Visible and obviously wrong beats
        // invisible and silently absent.
        return 0;
    }

    if (storeyHeight !== undefined && height <= storeyHeight) {
      z = Math.min(z, storeyHeight - height);
    }
    return Math.max(0, z);
  }

  static build(
    geometry: SourceGeometry,
    options: Partial<BuildOptions> = {},
  ): BuildResult {
    const opts: BuildOptions = { ...DEFAULT_BUILD_OPTIONS, ...options };
    const builder = new MeshBuilder();
    const warnings: string[] = [];

    // ── The drawing standard runs FIRST ───────────────────────────────────
    //
    // Grid lines, dimension strings, room tags, wall hatches, demolished
    // walls and everything above the cut plane are geometry in the file and
    // would extrude into solids here. The standard says which layers are
    // real; this drops the rest before a single triangle is emitted, so the
    // space they occupied stays empty.
    //
    // Set `enforceCadStandard: false` to build the raw file as it was
    // imported before — useful for a drawing that follows no standard at all.
    const filtered = applyCadStandard(geometry, {
      enforce: opts.enforceCadStandard,
      keepUnrecognised: opts.keepUnrecognisedLayers,
    });
    geometry = filtered.geometry;
    warnings.push(...filtered.warnings, ...describeDropped(filtered.dropped));

    // ── Split elevated linear geometry out of the wall list ───────────────
    //
    // The parser has no bucket for beams or ceiling grid members, so both
    // arrive in `walls`. Building them there would lay a beam across the
    // floor and drop the ceiling grid onto the slab — which is precisely why
    // they used to be excluded outright.
    //
    // They are genuinely linear extrusions, exactly like a wall; the only
    // difference is the height they start at and their section. So they are
    // separated here and built with their own elevation, rather than being
    // thrown away.
    const allWalls = Array.isArray(geometry.walls) ? geometry.walls : [];
    const walls: any[] = [];
    const elevated: Array<{ item: any; rule: ReturnType<typeof standards.classify> }> = [];

    for (const item of allWalls) {
      const layer = String(item?.layer ?? item?.layerName ?? '').trim();
      if (!layer) {
        walls.push(item);
        continue;
      }
      const rule = standards.classify(layer, item?.linetype);
      if (rule.solid === 'build' && rule.mount !== undefined) {
        elevated.push({ item, rule });
      } else {
        walls.push(item);
      }
    }
    const rooms = Array.isArray(geometry.rooms) ? geometry.rooms : [];
    const doors = Array.isArray(geometry.doors) ? geometry.doors : [];
    const windows = Array.isArray(geometry.windows) ? geometry.windows : [];
    const columns = Array.isArray(geometry.columns) ? geometry.columns : [];
    const stairs = Array.isArray(geometry.stairs) ? geometry.stairs : [];
    const furniture = Array.isArray(geometry.furniture) ? geometry.furniture : [];
    const devices = Array.isArray(geometry.devices) ? geometry.devices : [];
    const routes = Array.isArray(geometry.routes) ? geometry.routes : [];

    const wallHeight =
      Number(geometry.building?.floorHeight) > 0
        ? Number(geometry.building!.floorHeight)
        : opts.wallHeight;

    // The ceiling is the plane every ceiling-mounted device hangs from, so it
    // has to be derived once and shared rather than guessed per device.
    // A suspended ceiling sits below the structural floor-to-floor; 450 mm of
    // void is the usual allowance for ducts, tray and the grid itself.
    const ceilingHeight = Math.max(2.1, wallHeight - 0.45);

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
      stairTreads: 0,
      furniture: 0,
      devices: 0,
      routes: 0,
      beams: 0,
      ceilingMembers: 0,
      elevatedOther: 0,
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

    // ── Stairs ────────────────────────────────────────────────────────────
    //
    // A staircase is drawn as one line per tread, so the stair list holds
    // nosings, not staircases. Building a flight from each line produced one
    // complete staircase per tread — 154 of them, overlapping, in the
    // reference drawing — which is what made imported stairs unreadable.
    //
    // The lines are assembled into flights first, then one staircase is
    // built per flight with the step count the drawing actually shows.
    if (opts.includeStairs) {
      const assembly = assembleStairFlights(
        stairs
          .map((s: any) => this.stairSegment(s))
          .filter((s): s is StairSegment => s !== null),
      );
      warnings.push(...assembly.warnings);

      for (const flight of assembly.flights) {
        // A flight on a layer that starts above the cut plane rises from
        // there to the floor above, not from the slab.
        const rule = standards.classify(flight.layer);
        const baseZ = this.mountHeight(rule, ceilingHeight, 0);
        if (this.buildFlight(builder, flight, offset, wallHeight, baseZ)) {
          stats.stairs++;
          stats.stairTreads += flight.steps;
        }
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

    // ── Beams and ceiling grid ────────────────────────────────────────────
    //
    // Linear members built at their own elevation. A beam hangs under the
    // slab above at 300 x 400; a ceiling grid tee sits in the ceiling plane.
    // Each is keyed by role so the viewer can toggle and colour them apart
    // from the walls they would otherwise be indistinguishable from.
    for (const { item, rule } of elevated) {
      if (rule.role === 'beam' && !opts.includeBeams) continue;
      if (rule.role === 'ceiling' && !opts.includeCeilings) continue;

      const segment = this.wallSegment(item);
      if (!segment) continue;

      const thickness =
        Number(item.thickness) > 0
          ? Number(item.thickness)
          : (rule.thicknessMm ?? 200) / 1000;
      const depth = (rule.heightMm ?? 300) / 1000;
      const z = this.mountHeight(rule, ceilingHeight, depth, wallHeight);

      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;

      builder.addBox(
        `${rule.role}:${item.layer ?? 'unknown'}`,
        {
          x: (segment.start.x + segment.end.x) / 2 + offset.x,
          y: (segment.start.y + segment.end.y) / 2 + offset.y,
          z,
        },
        { x: dx, y: dy },
        length,
        thickness,
        depth,
      );

      // Counted by explicit role rather than with an `else`, so a layer that
      // starts arriving here unexpectedly shows up as uncounted instead of
      // silently inflating the ceiling tally — which is how 65 stair treads
      // first appeared to be ceiling grid.
      if (rule.role === 'beam') stats.beams++;
      else if (rule.role === 'ceiling') stats.ceilingMembers++;
      else stats.elevatedOther++;
    }

    // ── Equipment ─────────────────────────────────────────────────────────
    //
    // Each placement becomes a small solid at the height its layer puts it:
    // a camera under the ceiling, a socket at 300, a rack on the floor. The
    // mesh key is the layer name so the viewer can colour, label and toggle
    // each service independently instead of getting one undifferentiated
    // blob of equipment.
    if (opts.includeDevices) {
      for (const device of devices) {
        const position = this.point(device.position);
        if (!position) continue;

        const rule = standards.classify(String(device.layer ?? ''));
        const size = (rule.sizeMm ?? 200) / 1000;
        const height = (rule.heightMm ?? rule.sizeMm ?? 200) / 1000;
        const z = this.mountHeight(rule, ceilingHeight, height, wallHeight);
        const rotation = ((Number(device.rotation) || 0) * Math.PI) / 180;

        builder.addBox(
          `device:${device.layer ?? 'unknown'}`,
          { x: position.x + offset.x, y: position.y + offset.y, z },
          { x: Math.cos(rotation), y: Math.sin(rotation) },
          size,
          size,
          height,
        );
        stats.devices++;
      }
    }

    // ── Service runs ──────────────────────────────────────────────────────
    //
    // A run is swept segment by segment as a thin box along its own
    // direction. Using addBox per segment rather than one extrusion means a
    // tray that turns a corner stays continuous in plan without needing a
    // mitre solver — at 100 mm wide the join is not visible, and the
    // alternative (treating the polyline as a closed profile) would produce
    // a filled slab where a cable should be.
    if (opts.includeRoutes) {
      for (const route of routes) {
        const pts = Array.isArray(route.points) ? route.points : [];
        if (pts.length < 2) continue;

        const rule = standards.classify(String(route.layer ?? ''));
        const size = (rule.sizeMm ?? 60) / 1000;
        const z = this.mountHeight(rule, ceilingHeight, size, wallHeight);
        let emitted = false;

        for (let i = 0; i < pts.length - 1; i++) {
          const a = this.point(pts[i]);
          const b = this.point(pts[i + 1]);
          if (!a || !b) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length < 1e-6) continue;

          builder.addBox(
            `route:${route.layer ?? 'unknown'}`,
            {
              x: (a.x + b.x) / 2 + offset.x,
              y: (a.y + b.y) / 2 + offset.y,
              z,
            },
            { x: dx, y: dy },
            length,
            size,
            size,
          );
          emitted = true;
        }

        if (emitted) stats.routes++;
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
  /**
   * Reduce a parsed stair entry to the one line it really is.
   *
   * The parser stores a tread as a two-point `points` array; older stored
   * geometry may only carry `position` and `width`. Both are accepted so a
   * re-render of an existing plan does not lose its stairs.
   */
  private static stairSegment(stair: any): StairSegment | null {
    const pts = Array.isArray(stair?.points)
      ? stair.points
          .map((p: any) => this.point(p))
          .filter((p: Vec2 | null): p is Vec2 => p !== null)
      : [];

    if (pts.length >= 2) {
      return {
        start: pts[0],
        end: pts[pts.length - 1],
        layer: String(stair?.layer ?? ''),
      };
    }

    // Legacy shape: a centre point plus a width, with no direction. Treat it
    // as a tread running along X so it can still cluster with its neighbours.
    const centre = this.point(stair?.position);
    if (!centre) return null;
    const half = (Number(stair?.width) > 0 ? Number(stair.width) : 1.2) / 2;
    return {
      start: { x: centre.x - half, y: centre.y },
      end: { x: centre.x + half, y: centre.y },
      layer: String(stair?.layer ?? ''),
    };
  }

  /**
   * Build one assembled flight.
   *
   * Each tread is a box whose top is at that tread's finished level, so the
   * flight reads as a solid stair rather than as floating slabs. The rise is
   * shared out over the treads the drawing actually contains, which is what
   * makes the geometry match the plan instead of a 16-step assumption.
   */
  private static buildFlight(
    builder: MeshBuilder,
    flight: StairFlight,
    offset: Vec2,
    floorHeight: number,
    baseZ: number,
  ): boolean {
    const steps = Math.max(1, Math.min(120, flight.steps));
    const going = flight.runLength / steps;

    // A flight above the cut plane climbs only the part of the storey that
    // is left above it.
    const rise = Math.max(0.1, floorHeight - baseZ);
    const riser = rise / steps;

    if (!Number.isFinite(going) || going <= 0) return false;

    for (let i = 0; i < steps; i++) {
      const distance = going * (i + 0.5);
      builder.addBox(
        'stair',
        {
          x: flight.origin.x + flight.run.x * distance + offset.x,
          y: flight.origin.y + flight.run.y * distance + offset.y,
          z: baseZ,
        },
        flight.run,
        going,
        flight.width,
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
