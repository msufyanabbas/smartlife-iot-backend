// src/modules/floor-plans/parsers/dxf-floor-plan.parser.ts
//
// Comprehensive DXF → 3D geometry parser.
//
// Replaces the entity-classification half of DWGParserService. DWGParserService
// still owns file IO, DWG→DXF conversion, thumbnails and validation; it hands
// the DXF text to this class and stores what comes back.
//
// What this adds over the previous implementation:
//   • BLOCKS are expanded — INSERT references are resolved to their real
//     geometry, recursively, with insertion point / scale / rotation applied.
//     Previously an INSERT produced a single name-guessed marker and the block's
//     contents were invisible, which is fatal for AutoCAD-authored plans where
//     doors, windows, columns and furniture are almost always blocks.
//   • LWPOLYLINE bulge → real arc (door swings, curved walls).
//   • Doors and windows are derived from geometry, not just from block names.
//   • Columns are a first-class output.
//   • SOLID / 3DFACE contribute floor polygons.
//   • Per-layer colour + entity counts.
//   • Multilingual layer matching (EN/FR/DE/ES/AR).
//
// Coordinates: every coordinate, radius, thickness and area in the output is in
// METRES. $INSUNITS decides the factor; a drawing with no header is treated as
// already-metric (factor 1) rather than as millimetres, which is what used to
// shrink header-less files by 1000×.

import DxfParser from 'dxf-parser';

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedWall {
  id: string;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  /** Legacy alias for `[start, end]` — kept so existing renderers keep working. */
  points: Array<{ x: number; y: number; z?: number }>;
  thickness: number;
  height: number;
  layer: string;
  /** Legacy alias for `layer`. */
  material?: string;
  color?: number;
}

export interface ParsedRoom {
  id: string;
  vertices: Array<{ x: number; y: number }>;
  /** Legacy alias for `vertices`. */
  boundaries: Array<{ x: number; y: number }>;
  area: number;
  center: { x: number; y: number };
  layer: string;
  label?: string;
  /** Legacy alias for `label`. */
  name: string;
  floor: string;
}

export interface ParsedDoor {
  id: string;
  position: { x: number; y: number; z?: number };
  width: number;
  height: number;
  /** Degrees. */
  angle: number;
  /** Legacy alias for `angle`. */
  rotation: number;
  layer: string;
  type: 'single' | 'double' | 'sliding';
  swing?: {
    center: { x: number; y: number };
    radius: number;
    startAngle: number;
    endAngle: number;
  };
}

export interface ParsedWindow {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Midpoint — legacy renderers position windows by a single point. */
  position: { x: number; y: number; z?: number };
  width: number;
  height: number;
  rotation: number;
  layer: string;
}

export interface ParsedColumn {
  id: string;
  position: { x: number; y: number; z?: number };
  width: number;
  height: number;
  /** Extrusion height in metres (distinct from the footprint `height`). */
  depth: number;
  layer: string;
}

export interface ParsedStair {
  id: string;
  points: Array<{ x: number; y: number; z?: number }>;
  position: { x: number; y: number; z?: number };
  width: number;
  steps: number;
  layer: string;
}

export interface Parsed3DGeometry {
  walls: ParsedWall[];
  rooms: ParsedRoom[];
  doors: ParsedDoor[];
  windows: ParsedWindow[];
  columns: ParsedColumn[];
  stairs: ParsedStair[];
  furniture: Array<{
    id: string;
    type: string;
    position: { x: number; y: number; z?: number };
    rotation: number;
    dimensions: { width: number; height: number; depth: number };
  }>;

  layers: Array<{ name: string; color: number; entityCount: number }>;
  /** Plain layer names — the shape the previous output used. */
  layerNames: string[];

  boundingBox: {
    minX: number; minY: number; maxX: number; maxY: number;
    width: number; height: number;
  };
  /** Legacy alias for `boundingBox`. */
  bounds: {
    minX: number; minY: number; maxX: number; maxY: number;
    width: number; height: number;
  };

  building: {
    floorHeight: number;
    hasElevationData: boolean;
    elevationRange: { min: number; max: number };
    minElevation: number;
    maxElevation: number;
    totalArea: number;
  };

  units: string;
  scale: number;

  metrics: {
    entityCount: {
      lines: number; polylines: number; arcs: number; circles: number;
      inserts: number; texts: number; hatches: number; solids: number;
      expanded: number; total: number;
    };
  };

  // ── Raw capture ───────────────────────────────────────────────────────────
  // A DXF that is not an architectural plan (a bridge, a site plan) still
  // carries usable geometry. Nothing is discarded just because it could not be
  // classified.
  lines: Array<{ id: string; start: { x: number; y: number; z?: number }; end: { x: number; y: number; z?: number }; layer?: string }>;
  arcs: Array<{ id: string; center: { x: number; y: number; z?: number }; radius: number; startAngle: number; endAngle: number; points: Array<{ x: number; y: number }>; layer?: string }>;
  circles: Array<{ id: string; center: { x: number; y: number; z?: number }; radius: number; layer?: string }>;
  texts: Array<{ id: string; text: string; position: { x: number; y: number; z?: number }; layer?: string }>;
  entityCounts: Record<string, number>;
  totalEntities: number;
}

interface Transform {
  x: number; y: number; z: number;
  scaleX: number; scaleY: number; scaleZ: number;
  rotation: number; // degrees
}

const IDENTITY: Transform = {
  x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1, rotation: 0,
};

/** Guard against a malformed file with self-referencing blocks. */
const MAX_BLOCK_DEPTH = 8;

/**
 * Length below which a segment is considered degenerate (a duplicated point).
 * Deliberately near zero rather than a millimetre: the drawing's units are not
 * always known, so any real-world threshold throws away real geometry.
 */
const DEGENERATE = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// PARSER
// ─────────────────────────────────────────────────────────────────────────────

export class DxfFloorPlanParser {
  // Layer patterns — covers the common CAD standards and four extra languages.
  // Arabic entries matter here: local drawings label layers جدار / باب / نافذة.
  private static WALL_LAYERS = [
    /^wall/i, /^a-wall/i, /^arch.*wall/i, /^str.*wall/i,
    /^mur/i, /^wand/i, /^pared/i,
    /جدار/, /حائط/,
    /^walls$/i, /^wall-/i, /^_wall/i,
  ];

  private static DOOR_LAYERS = [
    /^door/i, /^a-door/i, /^arch.*door/i,
    /^porte/i, /^tuer/i, /^tür/i, /^puerta/i,
    /باب/, /^doors$/i,
  ];

  private static WINDOW_LAYERS = [
    /^window/i, /^win$/i, /^win-/i, /^a-glaz/i, /^a-wind/i, /^glazing/i,
    /^fenetre/i, /^fenêtre/i, /^fenster/i, /^ventana/i,
    /نافذة/, /شباك/,
  ];

  private static COLUMN_LAYERS = [
    /^column/i, /^col$/i, /^col-/i, /^pillar/i, /^a-col/i, /^s-col/i, /^str.*col/i,
    /^poteau/i, /^stütze/i, /^stutze/i,
    /عمود/, /^columns$/i,
  ];

  private static STAIR_LAYERS = [
    /^stair/i, /^a-str/i, /^steps/i,
    /درج/, /سلم/,
  ];

  private static ROOM_LAYERS = [
    /^room/i, /^space/i, /^area/i, /^a-room/i, /^a-area/i, /^a-flor/i, /^a-spce/i,
    /^hatch/i, /^fill/i,
    /غرفة/, /^rooms$/i,
  ];

  static matchesLayer(layerName: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(layerName));
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  static parse(dxfContent: string): Parsed3DGeometry {
    const parser = new DxfParser();
    let dxf: any;

    try {
      dxf = parser.parseSync(dxfContent);
    } catch (e: any) {
      throw new Error(`DXF parse failed: ${e?.message ?? e}`);
    }
    if (!dxf) throw new Error('DXF parse failed: parser returned null');

    const walls: ParsedWall[] = [];
    const rooms: ParsedRoom[] = [];
    const doors: ParsedDoor[] = [];
    const windows: ParsedWindow[] = [];
    const columns: ParsedColumn[] = [];
    const stairs: ParsedStair[] = [];
    const furniture: Parsed3DGeometry['furniture'] = [];
    const lines: Parsed3DGeometry['lines'] = [];
    const arcs: Parsed3DGeometry['arcs'] = [];
    const circles: Parsed3DGeometry['circles'] = [];
    const texts: Parsed3DGeometry['texts'] = [];

    const layerMap = new Map<string, { color: number; count: number }>();
    const entityCounts: Record<string, number> = {};

    const metrics = {
      lines: 0, polylines: 0, arcs: 0, circles: 0,
      inserts: 0, texts: 0, hatches: 0, solids: 0,
      expanded: 0, total: 0,
    };

    let idc = 0;
    const nextId = (p: string) => `${p}-${++idc}`;

    // ── Units ───────────────────────────────────────────────────────────────
    const units = this.getUnits(dxf);
    const scale = this.getScale(units);

    // Scale a raw DXF coordinate triple into metres.
    const S = (p: any): { x: number; y: number; z: number } => ({
      x: (p?.x ?? 0) * scale,
      y: (p?.y ?? 0) * scale,
      z: (p?.z ?? 0) * scale,
    });

    // ── Block definitions, for INSERT expansion ─────────────────────────────
    const blockDefs = new Map<string, any[]>();
    if (dxf.blocks) {
      for (const [blockName, block] of Object.entries<any>(dxf.blocks)) {
        if (block?.entities) blockDefs.set(blockName, block.entities);
      }
    }

    const rawEntities: any[] = dxf.entities ?? [];
    const allEntities = this.collectAllEntities(rawEntities, blockDefs);
    metrics.total = allEntities.length;
    metrics.expanded = Math.max(0, allEntities.length - rawEntities.length);

    // ── Entity loop ─────────────────────────────────────────────────────────
    for (const entity of allEntities) {
      const layer = entity.layer || '0';

      if (!layerMap.has(layer)) {
        layerMap.set(layer, { color: entity.colorIndex ?? entity.color ?? 0, count: 0 });
      }
      layerMap.get(layer)!.count++;
      entityCounts[entity.type] = (entityCounts[entity.type] ?? 0) + 1;

      const isDoor   = this.matchesLayer(layer, this.DOOR_LAYERS)   || this.blockHints(entity, 'door');
      const isWindow = this.matchesLayer(layer, this.WINDOW_LAYERS) || this.blockHints(entity, 'window');
      const isColumn = this.matchesLayer(layer, this.COLUMN_LAYERS) || this.blockHints(entity, 'column');
      const isStair  = this.matchesLayer(layer, this.STAIR_LAYERS)  || this.blockHints(entity, 'stair');
      const isRoom   = this.matchesLayer(layer, this.ROOM_LAYERS);

      switch (entity.type) {
        // ── LINE ───────────────────────────────────────────────────────────
        case 'LINE': {
          metrics.lines++;
          const v = entity.vertices ?? [];
          const start = S(v[0] ?? entity.start ?? entity.startPoint);
          const end   = S(v[1] ?? entity.end   ?? entity.endPoint);
          const len   = Math.hypot(end.x - start.x, end.y - start.y);

          lines.push({ id: nextId('line'), start, end, layer });
          // Only truly degenerate segments are dropped. A 1 mm cutoff is
          // absolute, so on a drawing whose units are unknown (a headerless
          // export, scale 1) it silently deletes a fifth of the linework.
          if (len < DEGENERATE) break;

          if (isDoor) {
            doors.push({
              id: nextId('door'),
              position: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: start.z },
              width: len,
              height: 2.1,
              angle: (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
              rotation: (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
              layer,
              type: 'single',
            });
          } else if (isWindow) {
            windows.push({
              id: nextId('window'),
              start: { x: start.x, y: start.y },
              end:   { x: end.x,   y: end.y },
              position: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: start.z },
              width: len,
              height: 1.5,
              rotation: (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
              layer,
            });
          } else if (isStair) {
            stairs.push({
              id: nextId('stair'),
              points: [start, end],
              position: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: start.z },
              width: len,
              steps: 0,
              layer,
            });
          } else {
            walls.push(this.makeWall(nextId('wall'), start, end, entity, layer, scale));
          }
          break;
        }

        // ── LWPOLYLINE / POLYLINE ──────────────────────────────────────────
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          metrics.polylines++;
          const verts = entity.vertices ?? [];
          if (verts.length < 2) break;

          const closed = entity.shape === true || entity.closed === true;
          const pts = verts.map((v: any) => S(v));

          if (isRoom && closed && pts.length >= 3) {
            const poly = pts.map((p: any) => ({ x: p.x, y: p.y }));
            const area = this.calcPolygonArea(poly);
            if (area > 0.1) {
              rooms.push(this.makeRoom(nextId('room'), poly, area, layer));
            }
            break;
          }

          if (isColumn && pts.length >= 4) {
            const poly = pts.map((p: any) => ({ x: p.x, y: p.y }));
            const xs = poly.map((p: any) => p.x);
            const ys = poly.map((p: any) => p.y);
            const c = this.calcPolygonCenter(poly);
            columns.push({
              id: nextId('column'),
              position: { x: c.x, y: c.y, z: pts[0].z },
              width:  Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
              depth: 3.0,
              layer,
            });
            break;
          }

          // Linework: every segment becomes a wall, and a bulged segment also
          // yields its true arc.
          for (let i = 0; i < verts.length - 1; i++) {
            const s = pts[i];
            const e = pts[i + 1];
            const len = Math.hypot(e.x - s.x, e.y - s.y);
            if (len > DEGENERATE) {
              walls.push(this.makeWall(nextId('wall'), s, e, entity, layer, scale));
            }

            const bulge = verts[i]?.bulge;
            if (bulge && Math.abs(bulge) > 0.001) {
              const arc = this.bulgeToArc(s.x, s.y, e.x, e.y, bulge);
              if (arc) {
                arcs.push({
                  id: nextId('arc'),
                  center: { x: arc.center.x, y: arc.center.y, z: s.z },
                  radius: arc.radius,
                  startAngle: (arc.startAngle * Math.PI) / 180,
                  endAngle: (arc.endAngle * Math.PI) / 180,
                  points: this.arcToPoints(arc.center.x, arc.center.y, arc.radius,
                    (arc.startAngle * Math.PI) / 180, (arc.endAngle * Math.PI) / 180),
                  layer,
                });
                if (isDoor) {
                  doors.push({
                    id: nextId('door'),
                    position: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2, z: s.z },
                    width: len,
                    height: 2.1,
                    angle: arc.startAngle,
                    rotation: arc.startAngle,
                    layer,
                    type: 'single',
                    swing: arc,
                  });
                }
              }
            }
          }

          if (closed && verts.length > 2) {
            const s = pts[pts.length - 1];
            const e = pts[0];
            if (Math.hypot(e.x - s.x, e.y - s.y) > DEGENERATE) {
              walls.push(this.makeWall(nextId('wall'), s, e, entity, layer, scale));
            }
            // A closed polyline also encloses an area — keep it as a room so a
            // building outline still produces a floor slab.
            const poly = pts.map((p: any) => ({ x: p.x, y: p.y }));
            const area = this.calcPolygonArea(poly);
            if (area > 0.1 && !isColumn) {
              rooms.push(this.makeRoom(nextId('room'), poly, area, layer));
            }
          }
          break;
        }

        // ── ARC ────────────────────────────────────────────────────────────
        case 'ARC': {
          metrics.arcs++;
          if (!entity.center) break;
          const c = S(entity.center);
          const r = (entity.radius ?? 0) * scale;
          // dxf-parser already converts the DXF's degrees to radians.
          const sa = entity.startAngle ?? 0;
          const ea = entity.endAngle ?? Math.PI * 2;

          arcs.push({
            id: nextId('arc'),
            center: c, radius: r, startAngle: sa, endAngle: ea,
            points: this.arcToPoints(c.x, c.y, r, sa, ea),
            layer,
          });

          if (isDoor) {
            doors.push({
              id: nextId('door'),
              position: { x: c.x, y: c.y, z: c.z },
              width: r,               // swing radius == door leaf width
              height: 2.1,
              angle: (sa * 180) / Math.PI,
              rotation: (sa * 180) / Math.PI,
              layer,
              type: 'single',
              swing: {
                center: { x: c.x, y: c.y },
                radius: r,
                startAngle: (sa * 180) / Math.PI,
                endAngle: (ea * 180) / Math.PI,
              },
            });
          } else {
            // A curved wall is still a wall — sample it rather than drop it.
            const pts = this.arcToPoints(c.x, c.y, r, sa, ea, 16);
            for (let i = 0; i < pts.length - 1; i++) {
              walls.push(this.makeWall(
                nextId('wall'),
                { x: pts[i].x, y: pts[i].y, z: c.z },
                { x: pts[i + 1].x, y: pts[i + 1].y, z: c.z },
                entity, layer, scale,
              ));
            }
          }
          break;
        }

        // ── CIRCLE ─────────────────────────────────────────────────────────
        case 'CIRCLE': {
          metrics.circles++;
          if (!entity.center) break;
          const c = S(entity.center);
          const r = (entity.radius ?? 0) * scale;
          circles.push({ id: nextId('circle'), center: c, radius: r, layer });

          if (isColumn) {
            columns.push({
              id: nextId('column'),
              position: { x: c.x, y: c.y, z: c.z },
              width: r * 2, height: r * 2, depth: 3.0,
              layer,
            });
          }
          break;
        }

        // ── INSERT ─────────────────────────────────────────────────────────
        // Geometry was already expanded by collectAllEntities(). What remains
        // here is an unresolved reference (block definition absent) — keep it as
        // a positional marker so the object is not lost entirely.
        case 'INSERT': {
          metrics.inserts++;
          const p = S(entity.position ?? entity.insertionPoint ?? { x: 0, y: 0, z: 0 });
          const name = String(entity.name ?? entity.block ?? '').toLowerCase();
          if (isDoor) {
            doors.push({
              id: nextId('door'), position: p, width: 0.9, height: 2.1,
              angle: entity.rotation ?? 0, rotation: entity.rotation ?? 0,
              layer, type: name.includes('double') ? 'double' : 'single',
            });
          } else if (isWindow) {
            windows.push({
              id: nextId('window'),
              start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, position: p,
              width: 1.2, height: 1.5, rotation: entity.rotation ?? 0, layer,
            });
          } else if (isColumn) {
            columns.push({
              id: nextId('column'), position: p,
              width: 0.4, height: 0.4, depth: 3.0, layer,
            });
          } else if (name) {
            furniture.push({
              id: nextId('furniture'), type: name, position: p,
              rotation: entity.rotation ?? 0,
              dimensions: { width: 1, height: 1, depth: 1 },
            });
          }
          break;
        }

        // ── TEXT / MTEXT ───────────────────────────────────────────────────
        case 'TEXT':
        case 'MTEXT': {
          metrics.texts++;
          const raw = entity.text ?? entity.string ?? '';
          const txt = this.stripMTextCodes(String(raw)).trim();
          if (!txt) break;
          const pos = S(entity.insertionPoint ?? entity.position ?? entity.startPoint);
          texts.push({ id: nextId('text'), text: txt, position: pos, layer });

          // Label the nearest unlabelled room within 10 m.
          let best: ParsedRoom | null = null;
          let bestD = 10;
          for (const r of rooms) {
            if (r.label) continue;
            const d = Math.hypot(r.center.x - pos.x, r.center.y - pos.y);
            if (d < bestD) { bestD = d; best = r; }
          }
          if (best) { best.label = txt; best.name = txt; }
          break;
        }

        // ── HATCH ──────────────────────────────────────────────────────────
        case 'HATCH': {
          metrics.hatches++;
          for (const poly of this.hatchPolygons(entity)) {
            const pts = poly.map((v: any) => {
              const s = S(v);
              return { x: s.x, y: s.y };
            });
            if (pts.length < 3) continue;
            const area = this.calcPolygonArea(pts);
            if (area > 0.1) rooms.push(this.makeRoom(nextId('room'), pts, area, layer));
          }
          break;
        }

        // ── SOLID / 3DFACE ─────────────────────────────────────────────────
        case 'SOLID':
        case '3DFACE': {
          metrics.solids++;
          const v = entity.vertices ?? entity.points ?? [];
          if (v.length < 3) break;
          const pts = v.map((p: any) => { const s = S(p); return { x: s.x, y: s.y }; });
          const area = this.calcPolygonArea(pts);
          if (area > 0.1) rooms.push(this.makeRoom(nextId('room'), pts, area, layer));
          break;
        }

        default:
          break;
      }
    }

    // ── Bounding box ────────────────────────────────────────────────────────
    // Reduce rather than Math.min(...spread): a large drawing overflows the
    // argument limit and throws RangeError.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const w of walls)   { consider(w.start.x, w.start.y); consider(w.end.x, w.end.y); }
    for (const l of lines)   { consider(l.start.x, l.start.y); consider(l.end.x, l.end.y); }
    for (const r of rooms)   for (const v of r.vertices) consider(v.x, v.y);
    for (const d of doors)   consider(d.position.x, d.position.y);
    for (const w of windows) { consider(w.start.x, w.start.y); consider(w.end.x, w.end.y); }
    for (const c of columns) consider(c.position.x, c.position.y);
    for (const a of arcs)    for (const p of a.points) consider(p.x, p.y);
    for (const c of circles) { consider(c.center.x - c.radius, c.center.y - c.radius); consider(c.center.x + c.radius, c.center.y + c.radius); }
    for (const t of texts)   consider(t.position.x, t.position.y);

    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 10; maxY = 10; }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const boundingBox = {
      minX, minY, maxX, maxY,
      width:  r2(maxX - minX),
      height: r2(maxY - minY),
    };

    // ── Elevation ───────────────────────────────────────────────────────────
    const zs: number[] = [];
    for (const w of walls) { zs.push(w.start.z, w.end.z); }
    const nonZero = zs.filter((z) => Math.abs(z) > 0.001);
    const hasElevationData = nonZero.length > 0;
    const zMin = zs.length ? Math.min(...zs.slice(0, 10000)) : 0;
    const zMax = zs.length ? Math.max(...zs.slice(0, 10000)) : 0;
    const floorHeight = hasElevationData ? (r2(zMax - zMin) || 3.0) : 3.0;

    const totalArea = r2(rooms.reduce((s, r) => s + r.area, 0));

    const layers = Array.from(layerMap.entries()).map(([name, info]) => ({
      name, color: info.color, entityCount: info.count,
    }));

    return {
      walls, rooms, doors, windows, columns, stairs, furniture,
      layers,
      layerNames: layers.map((l) => l.name),
      boundingBox,
      bounds: boundingBox,
      building: {
        floorHeight,
        hasElevationData,
        elevationRange: { min: zMin, max: zMax },
        minElevation: zMin,
        maxElevation: zMax,
        totalArea,
      },
      units,
      scale,
      metrics: { entityCount: metrics },
      lines, arcs, circles, texts,
      entityCounts,
      totalEntities: metrics.total,
    };
  }

  // ── Block expansion ───────────────────────────────────────────────────────

  /**
   * Flatten INSERT references into real geometry.
   *
   * Each level composes its transform with its parent's, so a door block nested
   * inside a wall-assembly block lands in the right place. Depth is capped
   * because a block that (directly or indirectly) inserts itself would recurse
   * forever.
   */
  private static collectAllEntities(
    entities: any[],
    blockDefs: Map<string, any[]>,
    parent: Transform = IDENTITY,
    depth = 0,
    inheritLayer?: string,
  ): any[] {
    const out: any[] = [];

    for (const entity of entities) {
      if (entity?.type === 'INSERT') {
        const blockName = entity.name ?? entity.block;
        const def = blockName ? blockDefs.get(blockName) : undefined;

        const local: Transform = {
          x: entity.position?.x ?? entity.insertionPoint?.x ?? 0,
          y: entity.position?.y ?? entity.insertionPoint?.y ?? 0,
          z: entity.position?.z ?? entity.insertionPoint?.z ?? 0,
          scaleX: entity.xScale ?? entity.scale?.x ?? 1,
          scaleY: entity.yScale ?? entity.scale?.y ?? 1,
          scaleZ: entity.zScale ?? entity.scale?.z ?? 1,
          rotation: entity.rotation ?? 0,
        };
        const composed = this.composeTransform(parent, local);

        if (!def || depth >= MAX_BLOCK_DEPTH) {
          // Unresolvable or too deep — keep the INSERT itself, transformed, so
          // the entity loop can still emit a marker for it.
          out.push(this.transformEntity(entity, parent, inheritLayer));
          continue;
        }

        // Recurse over the RAW block definition carrying the composed
        // transform. The definition must not be pre-transformed here: the leaf
        // push below applies the accumulated transform exactly once, and
        // transforming on the way down as well would apply it twice — which
        // put a door inserted at (3,8) at (6,16).
        out.push(
          ...this.collectAllEntities(
            def,
            blockDefs,
            composed,
            depth + 1,
            entity.layer ?? inheritLayer,
          ),
        );
      } else {
        out.push(this.transformEntity(entity, parent, inheritLayer));
      }
    }

    return out;
  }

  /** parent ∘ local — rotation adds, scale multiplies, translation rotates. */
  private static composeTransform(parent: Transform, local: Transform): Transform {
    const rad = (parent.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const lx = local.x * parent.scaleX;
    const ly = local.y * parent.scaleY;
    return {
      x: parent.x + lx * cos - ly * sin,
      y: parent.y + lx * sin + ly * cos,
      z: parent.z + local.z * parent.scaleZ,
      scaleX: parent.scaleX * local.scaleX,
      scaleY: parent.scaleY * local.scaleY,
      scaleZ: parent.scaleZ * local.scaleZ,
      rotation: parent.rotation + local.rotation,
    };
  }

  /**
   * Apply a transform to every point-bearing field of an entity.
   *
   * Entities inside a block definition are expressed in the block's own
   * coordinate system; the INSERT supplies where that system sits in the
   * drawing. Note the entity keeps its own layer when it has one — AutoCAD only
   * inherits the INSERT's layer for geometry drawn on layer "0".
   */
  private static transformEntity(e: any, t: Transform, inheritLayer?: string): any {
    if (!e) return e;
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);

    const tp = (pt: any) => {
      if (!pt) return pt;
      const x = (pt.x ?? 0) * t.scaleX;
      const y = (pt.y ?? 0) * t.scaleY;
      return {
        ...pt,
        x: t.x + x * cos - y * sin,
        y: t.y + x * sin + y * cos,
        z: (pt.z ?? 0) * t.scaleZ + t.z,
      };
    };

    const layer = !e.layer || e.layer === '0' ? (inheritLayer ?? e.layer ?? '0') : e.layer;
    const c: any = { ...e, layer };

    if (e.start)          c.start          = tp(e.start);
    if (e.end)            c.end            = tp(e.end);
    if (e.startPoint)     c.startPoint     = tp(e.startPoint);
    if (e.endPoint)       c.endPoint       = tp(e.endPoint);
    if (e.center)         c.center         = tp(e.center);
    if (e.position)       c.position       = tp(e.position);
    if (e.insertionPoint) c.insertionPoint = tp(e.insertionPoint);
    if (Array.isArray(e.vertices)) c.vertices = e.vertices.map(tp);

    // A radius scales with the drawing; non-uniform scale is approximated by the
    // mean, which is what CAD viewers do for a circle in a stretched block.
    if (typeof e.radius === 'number') {
      c.radius = e.radius * ((Math.abs(t.scaleX) + Math.abs(t.scaleY)) / 2);
    }
    if (typeof e.rotation === 'number') c.rotation = e.rotation + t.rotation;

    // An ARC's sweep must rotate with its block, or a door swing inserted at
    // 180° opens through the wall instead of into the room. dxf-parser reports
    // these two in radians while the INSERT's rotation is in degrees.
    if (t.rotation !== 0) {
      const rot = (t.rotation * Math.PI) / 180;
      if (typeof e.startAngle === 'number') c.startAngle = e.startAngle + rot;
      if (typeof e.endAngle === 'number') c.endAngle = e.endAngle + rot;
    }

    return c;
  }

  // ── Geometry helpers ──────────────────────────────────────────────────────

  private static makeWall(
    id: string,
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
    entity: any,
    layer: string,
    scale: number,
  ): ParsedWall {
    // DXF group code 39 ("thickness") is an *extrusion height*, not a wall
    // width, so it feeds `height`. Width has no DXF representation for a single
    // line and stays at the 0.1 m default until wall-pairing infers it.
    const extrusion = typeof entity?.thickness === 'number' ? entity.thickness * scale : 0;
    return {
      id,
      start, end,
      points: [start, end],
      thickness: 0.1,
      height: extrusion > 0.05 ? extrusion : 3.0,
      layer,
      material: layer,
      color: entity?.colorIndex ?? entity?.color,
    };
  }

  private static makeRoom(
    id: string,
    pts: Array<{ x: number; y: number }>,
    area: number,
    layer: string,
  ): ParsedRoom {
    const center = this.calcPolygonCenter(pts);
    return {
      id,
      vertices: pts,
      boundaries: pts,
      area: Math.round(area * 100) / 100,
      center,
      layer,
      name: 'Room',
      floor: 'ground',
    };
  }

  /**
   * Convert a bulge factor to the arc it describes.
   *
   * bulge = tan(θ/4), so radius = d(1+b²)/(4|b|). The centre lies on the chord's
   * perpendicular bisector at the *apothem* distance √(r² − (d/2)²) — not the
   * sagitta. Using the sagitta puts the centre inside the arc and misplaces
   * every door swing.
   */
  private static bulgeToArc(
    x1: number, y1: number, x2: number, y2: number, bulge: number,
  ): { center: { x: number; y: number }; radius: number; startAngle: number; endAngle: number } | null {
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d < 1e-9 || !Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return null;

    const r = (d * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const half = d / 2;
    const apothem = Math.sqrt(Math.max(0, r * r - half * half));

    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const ux = (x2 - x1) / d;
    const uy = (y2 - y1) / d;

    // Left normal for a positive (counter-clockwise) bulge.
    const sign = bulge > 0 ? 1 : -1;
    // |bulge| > 1 means the arc is the major one, so the centre flips sides.
    const major = Math.abs(bulge) > 1 ? -1 : 1;
    const cx = mx - uy * apothem * sign * major;
    const cy = my + ux * apothem * sign * major;

    return {
      center: { x: cx, y: cy },
      radius: r,
      startAngle: (Math.atan2(y1 - cy, x1 - cx) * 180) / Math.PI,
      endAngle:   (Math.atan2(y2 - cy, x2 - cx) * 180) / Math.PI,
    };
  }

  private static arcToPoints(
    cx: number, cy: number, radius: number,
    startRad: number, endRad: number, segments = 24,
  ): Array<{ x: number; y: number }> {
    const pts: Array<{ x: number; y: number }> = [];
    let start = startRad, end = endRad;
    if (end < start) end += Math.PI * 2;
    const step = (end - start) / segments;
    for (let i = 0; i <= segments; i++) {
      const a = start + i * step;
      pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
    return pts;
  }

  /** Every polygon a HATCH describes, across the shapes dxf-parser emits. */
  private static hatchPolygons(entity: any): any[][] {
    const out: any[][] = [];
    const paths = entity?.boundaryPaths ?? [];
    for (const p of paths) {
      if (Array.isArray(p?.vertices) && p.vertices.length) out.push(p.vertices);
      if (Array.isArray(p?.polylines)) {
        for (const poly of p.polylines) {
          if (Array.isArray(poly?.vertices) && poly.vertices.length) out.push(poly.vertices);
        }
      }
      // Edge-type boundaries: keep the straight ones; a full arc-edge
      // reconstruction is not attempted.
      if (Array.isArray(p?.edges)) {
        const pts = p.edges
          .filter((e: any) => e?.start)
          .map((e: any) => e.start);
        if (pts.length >= 3) out.push(pts);
      }
    }
    return out;
  }

  /** Shoelace. */
  private static calcPolygonArea(pts: Array<{ x: number; y: number }>): number {
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return Math.abs(area / 2);
  }

  private static calcPolygonCenter(pts: Array<{ x: number; y: number }>): { x: number; y: number } {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
  }

  /** Strip MTEXT inline formatting so a label reads as plain text. */
  private static stripMTextCodes(s: string): string {
    return s
      .replace(/\\[A-Za-z][^;]*;/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\P/g, ' ')
      .replace(/\\~/g, ' ')
      .replace(/\s+/g, ' ');
  }

  /** Block-name hints, for INSERTs whose layer says nothing useful. */
  private static blockHints(entity: any, kind: string): boolean {
    const n = String(entity?.name ?? entity?.block ?? '').toLowerCase();
    if (!n) return false;
    switch (kind) {
      case 'door':   return /door|porte|puerta|\bdr[-_]/.test(n);
      case 'window': return /window|glaz|fenster|ventana|\bwin[-_]/.test(n);
      case 'column': return /column|pillar|post|\bcol[-_]/.test(n);
      case 'stair':  return /stair|steps|escalier/.test(n);
      default:       return false;
    }
  }

  // ── Units ─────────────────────────────────────────────────────────────────

  /** $INSUNITS → unit name. Values follow the DXF specification. */
  private static getUnits(dxf: any): string {
    const insunits = dxf?.header?.$INSUNITS;
    const map: Record<number, string> = {
      0: 'unitless', 1: 'inches', 2: 'feet', 3: 'miles', 4: 'mm', 5: 'cm',
      6: 'meters', 7: 'km', 8: 'microinches', 9: 'mils', 10: 'yards',
      11: 'angstroms', 12: 'nanometers', 13: 'microns', 14: 'decimeters',
      15: 'dekameters', 16: 'hectometers', 17: 'gigameters',
      18: 'astronomical', 19: 'lightyears', 20: 'parsecs',
    };
    return map[insunits as number] ?? 'unitless';
  }

  /**
   * Unit name → metres.
   *
   * 'unitless' maps to 1, NOT 0.001. A DXF with no HEADER section (common for
   * exported/converted files) previously fell through to a millimetre
   * assumption and every coordinate was divided by 1000 — which is how a bridge
   * ended up 0.11 mm wide.
   */
  private static getScale(units: string): number {
    const map: Record<string, number> = {
      inches: 0.0254, feet: 0.3048, miles: 1609.344,
      mm: 0.001, cm: 0.01, meters: 1, km: 1000,
      microinches: 2.54e-8, mils: 2.54e-5, yards: 0.9144,
      angstroms: 1e-10, nanometers: 1e-9, microns: 1e-6,
      decimeters: 0.1, dekameters: 10, hectometers: 100,
      unitless: 1,
    };
    return map[units] ?? 1;
  }
}
