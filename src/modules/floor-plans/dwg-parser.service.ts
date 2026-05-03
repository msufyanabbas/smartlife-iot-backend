// src/modules/floor-plans/dwg-parser.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createCanvas } from 'canvas';
// Import only the default export (the parser class).
// We intentionally do NOT extend the package's IEntity because its shipped
// type declarations are too narrow — they omit most geometry fields that
// dxf-parser actually populates at runtime (startPoint, endPoint, vertices,
// center, radius, name, position, rotation, xScale, …).
// Instead we declare our own complete DxfEntity below and cast via `unknown`
// at the one point where IDxf entities enter our code.
import DxfParser from 'dxf-parser';
import { DWGGeometry } from '@common/interfaces/index.interface';

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface Point2D { x: number; y: number }
interface Point3D { x: number; y: number; z?: number }

/**
 * Complete entity shape as actually emitted by dxf-parser at runtime.
 * The package's own IEntity is far too narrow (it only declares `type`,
 * `handle`, and `layer`), so we define the full surface here instead.
 * This is the single source of truth for entity field access throughout
 * the service.
 */
interface DxfEntity {
  // ── Always present ────────────────────────────────────────────────────────
  type: string;
  handle?: number | string; // package declares number; we treat as opaque
  layer?: string;

  // ── LINE ──────────────────────────────────────────────────────────────────
  startPoint?: Point3D;
  endPoint?: Point3D;

  // ── LWPOLYLINE / POLYLINE ─────────────────────────────────────────────────
  vertices?: Point3D[];
  closed?: boolean;
  thickness?: number;
  elevation?: number;
  bulge?: number[];

  // ── ARC / CIRCLE ──────────────────────────────────────────────────────────
  center?: Point3D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;

  // ── INSERT (block reference) ───────────────────────────────────────────────
  name?: string;            // block name
  position?: Point3D;       // insertion point (some versions use this…)
  insertionPoint?: Point3D; // …others use this
  xScale?: number;
  yScale?: number;
  zScale?: number;
  rotation?: number;

  // ── TEXT / MTEXT ──────────────────────────────────────────────────────────
  text?: string;

  // ── HATCH ─────────────────────────────────────────────────────────────────
  boundaryPaths?: Array<{ vertices: Point2D[] }>;

  // ── DIMENSION ─────────────────────────────────────────────────────────────
  dimensionType?: number;

  // ── misc ──────────────────────────────────────────────────────────────────
  shape?: boolean;
}

/**
 * Minimal parsed-DXF shape — just what we need from the IDxf root object.
 * We avoid importing IDxf to stay decoupled from the package's narrow types.
 */
interface ParsedDxf {
  header?: {
    $INSUNITS?: number;
    $EXTMIN?: Point3D;
    $EXTMAX?: Point3D;
    $LIMMIN?: Point2D;
    $LIMMAX?: Point2D;
    [key: string]: unknown;
  };
  entities?: DxfEntity[];
  blocks?: Record<string, { entities: DxfEntity[] }>;
}

interface BoundingBox {
  minX: number; minY: number;
  maxX: number; maxY: number;
  width: number; height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AIA LAYER CLASSIFICATION TABLE
// Standard AIA CAD Layer Guidelines (AIA CAD Layer Guidelines, 3rd Edition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Layer name prefix → entity category mapping.
 * Covers AIA standard discipline prefixes:
 *   A- = Architectural, S- = Structural, M- = Mechanical,
 *   E- = Electrical, P- = Plumbing, I- = Interiors
 */
const LAYER_CATEGORY_MAP: Record<string, string> = {
  // Walls
  'A-WALL':      'wall',
  'A-WALL-FULL': 'wall',
  'A-WALL-PATT': 'wall',
  'A-WALL-MOVE': 'wall',
  'S-WALL':      'wall',
  'WALL':        'wall',
  'WALLS':       'wall',
  // Doors
  'A-DOOR':      'door',
  'A-DOOR-FULL': 'door',
  'A-DOOR-IDEN': 'door',
  'DOOR':        'door',
  'DOORS':       'door',
  // Windows
  'A-GLAZ':      'window',
  'A-GLAZ-FULL': 'window',
  'A-GLAZ-SILL': 'window',
  'A-WIND':      'window',
  'WINDOW':      'window',
  'WINDOWS':     'window',
  'WIN':         'window',
  // Rooms / Spaces
  'A-AREA':      'room',
  'A-AREA-IDEN': 'room',
  'A-FLOR':      'room',
  'A-FLOR-IDEN': 'room',
  'A-ROOM':      'room',
  'A-SPCE':      'room',
  'ROOM':        'room',
  'ROOMS':       'room',
  'SPACE':       'room',
  // Stairs
  'A-STRS':      'stair',
  'A-STRS-RAIS': 'stair',
  'A-STRS-STNG': 'stair',
  'STAIR':       'stair',
  'STAIRS':      'stair',
  // Furniture
  'A-FURN':      'furniture',
  'A-FURN-FREE': 'furniture',
  'A-FURN-FIXT': 'furniture',
  'I-FURN':      'furniture',
  'FURN':        'furniture',
  'FURNITURE':   'furniture',
  // Columns / Structural
  'S-COLS':      'column',
  'S-GRID':      'column',
  'A-COLS':      'column',
  'COLUMN':      'column',
};

/** Block name patterns → entity type (case-insensitive substring match) */
const BLOCK_DOOR_PATTERNS    = ['door', 'dr-', '_dr_', '-dr-', 'dr_', '_door'];
const BLOCK_WINDOW_PATTERNS  = ['window', 'win-', '_win', '-win', 'glazing', 'glaz'];
const BLOCK_STAIR_PATTERNS   = ['stair', 'strs', 'steps', 'ladder'];
const BLOCK_COLUMN_PATTERNS  = ['col-', 'column', 'post', 'pillar'];

// ─────────────────────────────────────────────────────────────────────────────
// UNIT CONVERSION  ($INSUNITS values per DXF spec)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns multiplier to convert DXF native units → meters */
function insUnitsToMeters(insUnits: number): number {
  switch (insUnits) {
    case 0:  return 0.001;   // unitless → assume mm
    case 1:  return 0.0254;  // inches
    case 2:  return 0.3048;  // feet
    case 3:  return 1609.34; // miles
    case 4:  return 0.001;   // mm
    case 5:  return 0.01;    // cm
    case 6:  return 1.0;     // meters
    case 7:  return 1000.0;  // km
    case 8:  return 0.000254;// microinches
    case 9:  return 2.54e-5; // mils
    case 10: return 0.9144;  // yards
    case 11: return 1e-10;   // angstroms
    case 12: return 1e-9;    // nanometers
    case 13: return 1e-6;    // microns
    case 14: return 100.0;   // decimeters → wait, dm = 0.1m
    default: return 0.001;   // fallback: mm
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DWGParserService {
  private readonly logger = new Logger(DWGParserService.name);

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Parse a DWG or DXF file and return normalised DWGGeometry.
   *
   * Pipeline:
   *   1. Detect file type
   *   2. If .dwg → convert to .dxf with libredwg `dwg2dxf`
   *   3. Parse .dxf with `dxf-parser`
   *   4. Classify entities by layer name (AIA) + block name patterns
   *   5. Normalise coordinates (unit conversion + origin shift)
   *   6. Run wall-merging + room-detection algorithms
   *   7. Return DWGGeometry; never throws – falls back to heuristics on error
   */
  async parseDWGFile(filePath: string): Promise<DWGGeometry> {
    this.logger.log(`parseDWGFile → ${filePath}`);

    let dxfPath = filePath;
    let tempDxf  = false;

    try {
      await fs.access(filePath);
    } catch {
      this.logger.error(`File not found: ${filePath}`);
      return this.emptyGeometry();
    }

    try {
      // ── Step 1: convert DWG → DXF if needed ──────────────────────────────
      if (filePath.toLowerCase().endsWith('.dwg')) {
        dxfPath  = filePath.replace(/\.dwg$/i, '_converted.dxf');
        tempDxf  = true;
        await this.convertDwgToDxf(filePath, dxfPath);
      }

      // ── Step 2: read & parse DXF ──────────────────────────────────────────
      const dxfText  = await fs.readFile(dxfPath, 'utf-8');
      const parsed   = this.parseDxfText(dxfText);

      if (!parsed || !parsed.entities) {
        this.logger.warn('dxf-parser returned empty result; returning empty geometry');
        return this.emptyGeometry();
      }

      // ── Step 3: resolve unit multiplier ──────────────────────────────────
      const insUnits = parsed.header?.$INSUNITS ?? 0;
      const scale    = insUnitsToMeters(insUnits);
      this.logger.log(`$INSUNITS=${insUnits}  →  scale factor=${scale}`);

      // ── Step 4: compute bounding box for origin normalisation ─────────────
      const bbox = this.computeBoundingBox(parsed.entities, scale);
      this.logger.log(`Bounding box: ${JSON.stringify(bbox)}`);

      // ── Step 5: classify & extract all entities ───────────────────────────
      const geometry = this.extractGeometry(parsed, scale, bbox);

      // ── Step 6: post-process ──────────────────────────────────────────────
      this.mergeParallelWalls(geometry);
      this.detectRoomsFromWalls(geometry);
      this.assignRoomNamesFromText(geometry, parsed.entities, scale, bbox);

      this.logger.log(
        `Parsing complete: ${geometry.walls.length} walls, ` +
        `${geometry.doors.length} doors, ${geometry.windows.length} windows, ` +
        `${geometry.rooms.length} rooms`,
      );

      return geometry;

    } catch (err: any) {
      this.logger.error(`parseDWGFile failed: ${err.message}`, err.stack);
      // Best-effort fallback: heuristic detection
      try {
        const dxfText = await fs.readFile(dxfPath, 'utf-8');
        const parsed  = this.parseDxfText(dxfText);
        if (parsed?.entities) {
          return this.heuristicFallback(parsed.entities, insUnitsToMeters(0));
        }
      } catch { /* ignore secondary error */ }
      return this.emptyGeometry();

    } finally {
      if (tempDxf) {
        await fs.unlink(dxfPath).catch(() => { /* ignore */ });
      }
    }
  }

  /**
   * Validate parsed geometry and return a list of human-readable errors.
   */
  validateGeometry(geometry: DWGGeometry): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!geometry.walls || geometry.walls.length === 0) {
      errors.push('No walls found in DWG file');
    }

    if (!geometry.rooms || geometry.rooms.length === 0) {
      errors.push('No rooms identified in DWG file');
    }

    geometry.walls?.forEach((wall, i) => {
      if (!wall.points || wall.points.length < 2) {
        errors.push(`Wall[${i}] (id=${wall.id}) has fewer than 2 points`);
      }
    });

    geometry.doors?.forEach((door, i) => {
      if (door.width <= 0 || door.height <= 0) {
        errors.push(`Door[${i}] (id=${door.id}) has invalid dimensions`);
      }
    });

    return { valid: errors.length === 0, errors };
  }

  /**
   * Render parsed geometry to a 2D PNG thumbnail (800 × 600 px).
   *
   * Visual legend:
   *   - White background
   *   - Light-grey room fills
   *   - Black walls (2 px stroke)
   *   - Blue doors (with swing arc)
   *   - Cyan windows
   *
   * @returns The output file path (same as `outputPath` argument).
   */
  async generateThumbnail(geometry: DWGGeometry, outputPath: string): Promise<string> {
    const W = 800, H = 600, PADDING = 40;

    try {
      const canvas  = createCanvas(W, H);
      const ctx     = canvas.getContext('2d');

      // ── Background ────────────────────────────────────────────────────────
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // ── Compute geometry bounding box ─────────────────────────────────────
      const allPoints: Point2D[] = [];
      geometry.walls.forEach(w => w.points.forEach(p => allPoints.push(p)));
      geometry.rooms.forEach(r => r.boundaries.forEach(p => allPoints.push(p)));

      if (allPoints.length === 0) {
        await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
        return outputPath;
      }

      const gMinX = Math.min(...allPoints.map(p => p.x));
      const gMaxX = Math.max(...allPoints.map(p => p.x));
      const gMinY = Math.min(...allPoints.map(p => p.y));
      const gMaxY = Math.max(...allPoints.map(p => p.y));
      const gW    = gMaxX - gMinX || 1;
      const gH    = gMaxY - gMinY || 1;

      const drawW = W - PADDING * 2;
      const drawH = H - PADDING * 2;
      const scaleX = drawW / gW;
      const scaleY = drawH / gH;
      const sc     = Math.min(scaleX, scaleY);

      /** Map geometry coords → canvas pixel coords (Y is flipped) */
      const px = (x: number) => PADDING + (x - gMinX) * sc;
      const py = (y: number) => H - PADDING - (y - gMinY) * sc;

      // ── Rooms (fill) ──────────────────────────────────────────────────────
      geometry.rooms.forEach(room => {
        if (room.boundaries.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(px(room.boundaries[0].x), py(room.boundaries[0].y));
        room.boundaries.slice(1).forEach(p => ctx.lineTo(px(p.x), py(p.y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(200,220,240,0.4)';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Room label
        const cx = room.boundaries.reduce((s, p) => s + p.x, 0) / room.boundaries.length;
        const cy = room.boundaries.reduce((s, p) => s + p.y, 0) / room.boundaries.length;
        ctx.fillStyle   = '#334155';
        ctx.font        = '10px sans-serif';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(room.name, px(cx), py(cy));
      });

      // ── Walls ─────────────────────────────────────────────────────────────
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth   = 2;
      geometry.walls.forEach(wall => {
        if (wall.points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(px(wall.points[0].x), py(wall.points[0].y));
        wall.points.slice(1).forEach(p => ctx.lineTo(px(p.x), py(p.y)));
        ctx.stroke();
      });

      // ── Doors ─────────────────────────────────────────────────────────────
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth   = 1.5;
      geometry.doors.forEach(door => {
        const dpx  = px(door.position.x);
        const dpy  = py(door.position.y);
        const dw   = door.width * sc;
        const rot  = (-door.rotation * Math.PI) / 180;

        ctx.save();
        ctx.translate(dpx, dpy);
        ctx.rotate(rot);

        // Door leaf
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(dw, 0);
        ctx.stroke();

        // Swing arc
        ctx.beginPath();
        ctx.arc(0, 0, dw, 0, Math.PI / 2);
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();
      });

      // ── Windows ───────────────────────────────────────────────────────────
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth   = 2;
      geometry.windows.forEach(win => {
        const wpx  = px(win.position.x);
        const wpy  = py(win.position.y);
        const ww   = win.width * sc;
        const rot  = (-win.rotation * Math.PI) / 180;

        ctx.save();
        ctx.translate(wpx, wpy);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(-ww / 2, 0);
        ctx.lineTo(ww / 2, 0);
        ctx.stroke();
        // centre tick
        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.lineTo(0, 4);
        ctx.stroke();
        ctx.restore();
      });

      // ── Write PNG ─────────────────────────────────────────────────────────
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(outputPath, canvas.toBuffer('image/png'));

      this.logger.log(`Thumbnail written → ${outputPath}`);
      return outputPath;

    } catch (err: any) {
      this.logger.error(`generateThumbnail failed: ${err.message}`, err.stack);
      return outputPath; // return path even on failure; caller checks existence
    }
  }

  // ── Private: DWG → DXF conversion ─────────────────────────────────────────

  /**
   * Convert a DWG file to DXF.
   *
   * Strategy (tried in order):
   *   1. dwg2dxf      — libredwg CLI  (Linux / macOS / WSL)
   *   2. ODAFileConverter — ODA File Converter CLI  (Windows, free download)
   *   3. Clear error with installation instructions for the current platform
   *
   * ── Installation ──────────────────────────────────────────────────────────
   *
   * Linux / Ubuntu:
   *   sudo apt-get install libredwg-utils
   *
   * macOS:
   *   brew install libredwg
   *
   * Windows (choose one):
   *
   *   Option A — ODA File Converter (recommended, free GUI + CLI):
   *     1. Download from https://www.opendesign.com/guestfiles/oda_file_converter
   *     2. Install (adds ODAFileConverter.exe to Program Files)
   *     3. Add install directory to your PATH, OR set env var:
   *          ODA_CONVERTER_PATH=C:\Program Files\ODA\ODAFileConverter 25.6.0
   *
   *   Option B — WSL with libredwg:
   *     wsl sudo apt-get install libredwg-utils
   *     The service auto-detects WSL and uses it.
   *
   *   Option C — Convert to DXF first (simplest for testing):
   *     Open the DWG in any CAD viewer (DWG TrueView, LibreCAD, FreeCAD)
   *     and Save As / Export → DXF. Then pass the .dxf file to the parser.
   */
  private async convertDwgToDxf(dwgPath: string, dxfPath: string): Promise<void> {
    this.logger.log(`Converting DWG → DXF: ${dwgPath}`);

    const isWindows = process.platform === 'win32';
    const outDir    = path.dirname(dxfPath);
    const outFile   = path.basename(dxfPath);

    // ── 1. Try dwg2dxf (Linux / macOS native, or WSL on Windows) ─────────────
    if (!isWindows) {
      try {
        const { stderr } = await execAsync(
          `dwg2dxf -o "${dxfPath}" "${dwgPath}"`,
          { timeout: 60_000 },
        );
        if (stderr) this.logger.warn(`dwg2dxf stderr: ${stderr}`);
        await fs.access(dxfPath);
        return; // success
      } catch (err: any) {
        this.logger.warn(`dwg2dxf failed: ${err.message} — trying fallbacks`);
      }
    }

    // ── 2. Try ODA File Converter (Windows primary, also works on Linux/Mac) ──
    const odaFromEnv  = process.env.ODA_CONVERTER_PATH;
    const odaCandidates = [
      odaFromEnv,
      // Common Windows install paths
      'C:\\Program Files\\ODA\\ODAFileConverter 25.6.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 24.12.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 24.6.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 23.12.0\\ODAFileConverter.exe',
      'ODAFileConverter', // if on PATH
    ].filter(Boolean) as string[];

    for (const odaExe of odaCandidates) {
      const exePath = odaExe.endsWith('.exe') || !odaExe.includes('\\')
        ? odaExe
        : path.join(odaExe, 'ODAFileConverter.exe');

      try {
        // ODA CLI: ODAFileConverter <inputFolder> <outputFolder> <version> <fileType> <recurse> <audit> [filter]
        // version: ACAD2018  fileType: DXF  recurse: 0  audit: 1
        const dwgDir  = path.dirname(dwgPath);
        const dwgBase = path.basename(dwgPath, '.dwg');

        // ODA outputs <filename>.dxf in the output folder
        const odaCmd = `"${exePath}" "${dwgDir}" "${outDir}" ACAD2018 DXF 0 1 "${dwgBase}.dwg"`;
        this.logger.log(`Trying ODA File Converter: ${odaCmd}`);

        const { stderr } = await execAsync(odaCmd, { timeout: 120_000 });
        if (stderr) this.logger.warn(`ODA stderr: ${stderr}`);

        // ODA names output <basename>.dxf — rename if needed
        const odaOutput = path.join(outDir, `${dwgBase}.dxf`);
        if (odaOutput !== dxfPath) {
          await fs.rename(odaOutput, dxfPath);
        }
        await fs.access(dxfPath);
        this.logger.log('ODA File Converter succeeded');
        return; // success
      } catch {
        // try next candidate
      }
    }

    // ── 3. WSL fallback on Windows ─────────────────────────────────────────
    if (isWindows) {
      try {
        // Convert Windows paths to WSL paths
        const wslDwg = dwgPath.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
        const wslDxf = dxfPath.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
        const { stderr } = await execAsync(
          `wsl dwg2dxf -o "${wslDxf}" "${wslDwg}"`,
          { timeout: 60_000 },
        );
        if (stderr) this.logger.warn(`WSL dwg2dxf stderr: ${stderr}`);
        await fs.access(dxfPath);
        this.logger.log('WSL dwg2dxf succeeded');
        return;
      } catch (err: any) {
        this.logger.warn(`WSL dwg2dxf failed: ${err.message}`);
      }
    }

    // ── All converters failed — throw with clear instructions ──────────────
    const instructions = isWindows
      ? [
          'DWG→DXF conversion failed on Windows. Fix one of these:',
          '',
          '  OPTION A (recommended) — Install ODA File Converter:',
          '    1. Download free from https://www.opendesign.com/guestfiles/oda_file_converter',
          '    2. Install it, then either:',
          '       a) Add its folder to your PATH, OR',
          '       b) Set env var: ODA_CONVERTER_PATH=C:\\Program Files\\ODA\\ODAFileConverter 25.6.0',
          '',
          '  OPTION B — Use WSL:',
          '    wsl sudo apt-get install libredwg-utils',
          '',
          '  OPTION C — Convert to DXF manually (quickest for testing):',
          '    Open the DWG in DWG TrueView, LibreCAD, or FreeCAD → Save As DXF',
          '    Then run: test-real-file.ts yourfile.dxf',
        ].join('\n')
      : [
          'DWG→DXF conversion failed. Install libredwg:',
          '  Ubuntu/Debian: sudo apt-get install libredwg-utils',
          '  macOS:         brew install libredwg',
        ].join('\n');

    throw new Error(instructions);
  }

  // ── Private: DXF parsing ───────────────────────────────────────────────────

  /**
   * Wrap the dxf-parser library call so we can handle its sync/async variance.
   */
  private parseDxfText(dxfText: string): ParsedDxf | null {
    // parseSync returns the package's own IDxf | null.  We cast via `unknown`
    // because our ParsedDxf is a structurally equivalent but independently
    // declared interface — the shapes match at runtime even though TS sees
    // them as unrelated nominal types (handle: number vs number|string, etc.)
    const parser = new DxfParser();
    return parser.parseSync(dxfText) as unknown as ParsedDxf | null;
  }

  // ── Private: bounding box ──────────────────────────────────────────────────

  /**
   * Walk every entity and collect all coordinate points to derive the overall
   * bounding box in *meter* space (already scaled by `scale`).
   */
  private computeBoundingBox(entities: DxfEntity[], scale: number): BoundingBox {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    const consider = (x: number, y: number) => {
      const sx = x * scale, sy = y * scale;
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    };

    entities.forEach(e => {
      this.entityPoints(e).forEach(p => consider(p.x, p.y));
    });

    if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }

    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  // ── Private: main geometry extractor ──────────────────────────────────────

  /**
   * Classify and extract all DXF entities into the DWGGeometry structure.
   */
  private extractGeometry(
    parsed: ParsedDxf,
    scale: number,
    bbox: BoundingBox,
  ): DWGGeometry {
    const geometry = this.emptyGeometry();
    const entities = (parsed.entities ?? []);
    let idCounter  = 0;
    const nextId   = (prefix: string) => `${prefix}-${++idCounter}`;

    // Helper: normalise a raw DXF point to meter-space, origin at bbox min
    const norm = (x: number, y: number, z = 0): Point3D => ({
      x: x * scale - bbox.minX,
      y: y * scale - bbox.minY,
      z: z * scale,
    });
    const norm2 = (x: number, y: number): Point2D => ({
      x: x * scale - bbox.minX,
      y: y * scale - bbox.minY,
    });

    for (const entity of entities) {
      const layerRaw  = (entity.layer ?? '').toUpperCase().trim();
      const category  = this.classifyLayer(layerRaw);

      switch (entity.type) {

        // ── LINE ─────────────────────────────────────────────────────────────
        // dxf-parser stores LINE endpoints in vertices[0] and vertices[1],
        // NOT in startPoint/endPoint (despite what IEntity types suggest).
        case 'LINE': {
          const verts = entity.vertices ?? [];
          if (verts.length < 2) break;
          const pts: Point3D[] = [
            norm(verts[0].x, verts[0].y, verts[0].z ?? 0),
            norm(verts[1].x, verts[1].y, verts[1].z ?? 0),
          ];
          // Ignore lines shorter than 0.5 m — these are dimension ticks,
          // hatching leaders, or annotation geometry, not structural walls.
          const lineLen = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          if (lineLen < 0.5) break;
          if (category === 'wall' || category === 'unknown') {
            geometry.walls.push({
              id:        nextId('wall'),
              points:    pts,
              thickness: 0.2,
              height:    3.0,
              material:  layerRaw || 'default',
            });
          }
          break;
        }

        // ── LWPOLYLINE / POLYLINE ─────────────────────────────────────────
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          const verts = (entity.vertices ?? []).map(v =>
            norm(v.x, v.y, v.z ?? 0),
          );
          if (verts.length < 2) break;

          if (category === 'room') {
            const bounds2D = verts.map(v => ({ x: v.x, y: v.y }));
            geometry.rooms.push({
              id:         nextId('room'),
              name:       this.layerToRoomName(layerRaw),
              boundaries: bounds2D,
              area:       this.polygonArea(bounds2D),
              floor:      'ground',
            });
          } else {
            // Default to wall (also catches 'unknown' on closed polylines)
            geometry.walls.push({
              id:        nextId('wall'),
              points:    verts,
              thickness: entity.thickness ?? 0.2,
              height:    3.0,
              material:  layerRaw || 'default',
            });
          }
          break;
        }

        // ── ARC (curved wall / door swing) ───────────────────────────────
        // NOTE: dxf-parser converts DXF degree values to radians internally.
        // arcToPoints receives radians directly — do NOT multiply by π/180.
        case 'ARC': {
          if (!entity.center) break;
          const arcPts = this.arcToPoints(
            entity.center.x * scale - bbox.minX,
            entity.center.y * scale - bbox.minY,
            (entity.radius ?? 1) * scale,
            entity.startAngle ?? 0,        // already radians
            entity.endAngle   ?? Math.PI * 2,
          );
          if (category !== 'door') {
            geometry.walls.push({
              id:        nextId('wall'),
              points:    arcPts.map(p => ({ x: p.x, y: p.y, z: 0 })),
              thickness: 0.2,
              height:    3.0,
              material:  layerRaw || 'default',
            });
          }
          break;
        }

        // ── CIRCLE (column / post) ────────────────────────────────────────
        case 'CIRCLE': {
          if (!entity.center) break;
          // Represent as a very small room boundary or ignore;
          // store in furniture as 'column'
          const r = (entity.radius ?? 0.3) * scale;
          if (!geometry.furniture) geometry.furniture = [];
          geometry.furniture.push({
            id:         nextId('column'),
            type:       'column',
            position:   norm(entity.center.x, entity.center.y, entity.center.z ?? 0),
            rotation:   0,
            dimensions: { width: r * 2, height: 3.0, depth: r * 2 },
          });
          break;
        }

        // ── INSERT (block reference: doors, windows, furniture) ───────────
        case 'INSERT': {
          const blockName = (entity.name ?? '').toLowerCase();
          const insPos    = entity.position ?? entity.insertionPoint ?? { x: 0, y: 0, z: 0 };
          const position  = norm(insPos.x, insPos.y, insPos.z ?? 0);
          const xSc       = (entity.xScale ?? 1) * scale;
          const ySc       = (entity.yScale ?? 1) * scale;
          const rot       = entity.rotation ?? 0;

          const blockCategory =
            this.classifyLayer(layerRaw) !== 'unknown'
              ? this.classifyLayer(layerRaw)
              : this.classifyBlockName(blockName);

          if (blockCategory === 'door') {
            geometry.doors.push({
              id:       nextId('door'),
              position,
              width:    xSc > 0.05 ? xSc : 0.9,
              height:   ySc > 0.5  ? ySc : 2.1,
              rotation: rot,
              type:     blockName.includes('double') ? 'double' : 'single',
            });
          } else if (blockCategory === 'window') {
            geometry.windows.push({
              id:       nextId('window'),
              position,
              width:    xSc > 0.05 ? xSc : 1.2,
              height:   ySc > 0.3  ? ySc : 1.5,
              rotation: rot,
            });
          } else if (blockCategory === 'stair') {
            geometry.stairs.push({
              id:         nextId('stair'),
              x:          position.x,
              y:          position.y,
              z:          position.z ?? 0,
              rotation:   rot,
            } as any);
          } else if (blockCategory !== 'unknown') {
            if (!geometry.furniture) geometry.furniture = [];
            geometry.furniture.push({
              id:         nextId('furniture'),
              type:       blockName || 'generic',
              position,
              rotation:   rot,
              dimensions: {
                width:  xSc || 1,
                height: (entity.zScale ?? 1) * scale || 1,
                depth:  ySc || 1,
              },
            });
          }
          break;
        }

        // ── HATCH (room fills) ────────────────────────────────────────────
        case 'HATCH': {
          if (!entity.boundaryPaths) break;
          for (const bp of entity.boundaryPaths) {
            const verts = (bp.vertices ?? []).map(v => norm2(v.x, v.y));
            if (verts.length < 3) continue;
            geometry.rooms.push({
              id:         nextId('room'),
              name:       this.layerToRoomName(layerRaw),
              boundaries: verts,
              area:       this.polygonArea(verts),
              floor:      'ground',
            });
          }
          break;
        }

        // ── TEXT / MTEXT (handled in post-process) ────────────────────────
        case 'TEXT':
        case 'MTEXT':
          // Handled later in assignRoomNamesFromText
          break;

        default:
          break;
      }
    }

    return geometry;
  }

  // ── Private: layer classification ─────────────────────────────────────────

  /**
   * Resolve a DXF layer name to a semantic category using the AIA table.
   * Performs prefix matching so "A-WALL-DEMO" → "wall".
   */
  private classifyLayer(layerName: string): string {
    // Exact match first
    if (LAYER_CATEGORY_MAP[layerName]) return LAYER_CATEGORY_MAP[layerName];

    // Prefix match (handles "A-WALL-DEMO", "A-DOOR-FIRE", etc.)
    for (const [prefix, cat] of Object.entries(LAYER_CATEGORY_MAP)) {
      if (layerName.startsWith(prefix)) return cat;
    }

    // Loose substring match as last resort
    const l = layerName.toLowerCase();
    if (l.includes('wall'))      return 'wall';
    if (l.includes('door'))      return 'door';
    if (l.includes('window') || l.includes('glaz')) return 'window';
    if (l.includes('room') || l.includes('space') || l.includes('area')) return 'room';
    if (l.includes('stair'))     return 'stair';
    if (l.includes('furn'))      return 'furniture';
    if (l.includes('col'))       return 'column';

    return 'unknown';
  }

  /**
   * Classify a block name (INSERT entity) into a semantic category.
   */
  private classifyBlockName(blockName: string): string {
    const l = blockName.toLowerCase();
    if (BLOCK_DOOR_PATTERNS.some(p   => l.includes(p))) return 'door';
    if (BLOCK_WINDOW_PATTERNS.some(p => l.includes(p))) return 'window';
    if (BLOCK_STAIR_PATTERNS.some(p  => l.includes(p))) return 'stair';
    if (BLOCK_COLUMN_PATTERNS.some(p => l.includes(p))) return 'column';
    return 'unknown';
  }

  // ── Private: wall merging ──────────────────────────────────────────────────

  /**
   * Merge parallel wall pairs whose perpendicular spacing is < 0.5 m into a
   * single wall whose thickness equals the spacing.
   *
   * Algorithm:
   *   1. For every pair of 2-point walls:
   *      a. Check if they are parallel (dot-product of unit vectors > 0.98)
   *      b. Compute perpendicular distance between their midpoints
   *      c. If distance < 0.5 m → merge into a single wall at the midpoint,
   *         set thickness = distance, remove the two originals.
   */
  private mergeParallelWalls(geometry: DWGGeometry): void {
    const walls  = geometry.walls;
    const merged = new Set<number>();

    for (let i = 0; i < walls.length; i++) {
      if (merged.has(i)) continue;
      const wa = walls[i];
      if (wa.points.length !== 2) continue;

      for (let j = i + 1; j < walls.length; j++) {
        if (merged.has(j)) continue;
        const wb = walls[j];
        if (wb.points.length !== 2) continue;

        if (this.wallsAreParallel(wa, wb)) {
          const dist = this.perpendicularDistance(wa, wb);
          if (dist > 0 && dist < 0.5) {
            // Replace wa with merged wall, mark wb for removal
            wa.points    = this.midWallPoints(wa, wb);
            wa.thickness = dist;
            merged.add(j);
          }
        }
      }
    }

    geometry.walls = walls.filter((_, i) => !merged.has(i));
  }

  private wallsAreParallel(
    wa: DWGGeometry['walls'][0],
    wb: DWGGeometry['walls'][0],
  ): boolean {
    const da = this.wallDirection(wa);
    const db = this.wallDirection(wb);
    const dot = Math.abs(da.x * db.x + da.y * db.y);
    return dot > 0.97; // ~14° tolerance
  }

  private wallDirection(wall: DWGGeometry['walls'][0]): Point2D {
    const dx = wall.points[1].x - wall.points[0].x;
    const dy = wall.points[1].y - wall.points[0].y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  private perpendicularDistance(
    wa: DWGGeometry['walls'][0],
    wb: DWGGeometry['walls'][0],
  ): number {
    // Project midpoint of wb onto wa's normal
    const ma = {
      x: (wa.points[0].x + wa.points[1].x) / 2,
      y: (wa.points[0].y + wa.points[1].y) / 2,
    };
    const mb = {
      x: (wb.points[0].x + wb.points[1].x) / 2,
      y: (wb.points[0].y + wb.points[1].y) / 2,
    };
    const da    = this.wallDirection(wa);
    const normal = { x: -da.y, y: da.x };
    return Math.abs((mb.x - ma.x) * normal.x + (mb.y - ma.y) * normal.y);
  }

  private midWallPoints(
    wa: DWGGeometry['walls'][0],
    wb: DWGGeometry['walls'][0],
  ): Point3D[] {
    return [
      {
        x: (wa.points[0].x + wb.points[0].x) / 2,
        y: (wa.points[0].y + wb.points[0].y) / 2,
        z: (wa.points[0].z ?? 0 + (wb.points[0].z ?? 0)) / 2,
      },
      {
        x: (wa.points[1].x + wb.points[1].x) / 2,
        y: (wa.points[1].y + wb.points[1].y) / 2,
        z: ((wa.points[1].z ?? 0) + (wb.points[1].z ?? 0)) / 2,
      },
    ];
  }

  // ── Private: room detection from wall intersections ────────────────────────

  /**
   * Detect rooms from wall intersections using a simplified connectivity graph.
   *
   * Algorithm:
   *   1. Build an adjacency list of wall endpoints that are within `snapTol` m
   *      of each other (shared vertices / T-intersections).
   *   2. Find minimum cycles of length 3–8 in the graph → candidate rooms.
   *   3. Each cycle's convex hull becomes a room boundary.
   *   4. Rooms with area < 1 m² are discarded.
   *   5. Only add rooms not already covered by HATCH/POLYLINE extraction.
   */
  private detectRoomsFromWalls(geometry: DWGGeometry): void {
    // Skip if enough rooms already found (HATCH or POLYLINE based)
    if (geometry.rooms.length >= 3) return;

    const SNAP = 0.15; // metres – points within this distance are "the same"

    // Collect unique endpoints
    const pts: Point2D[]  = [];
    const wallEdges: Array<[number, number]> = [];

    const findOrAdd = (p: Point2D): number => {
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) < SNAP) return i;
      }
      pts.push({ x: p.x, y: p.y });
      return pts.length - 1;
    };

    for (const wall of geometry.walls) {
      if (wall.points.length < 2) continue;
      const startIdx = findOrAdd(wall.points[0]);
      const endIdx   = findOrAdd(wall.points[wall.points.length - 1]);
      if (startIdx !== endIdx) wallEdges.push([startIdx, endIdx]);
    }

    // Build adjacency list
    const adj = new Map<number, Set<number>>();
    for (const [a, b] of wallEdges) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }

    // DFS to find small cycles (rooms)
    const foundRooms: Point2D[][] = [];
    const visited = new Set<string>();

    const cycleKey = (cycle: number[]) =>
      [...cycle].sort((a, b) => a - b).join('-');

    const dfs = (
      start: number,
      current: number,
      path: number[],
      depth: number,
    ) => {
      if (depth > 8) return;
      const neighbours = adj.get(current) ?? new Set();
      for (const next of neighbours) {
        if (depth >= 3 && next === start) {
          // Closed cycle found
          const key = cycleKey(path);
          if (!visited.has(key)) {
            visited.add(key);
            const boundary = path.map(i => pts[i]);
            const area     = this.polygonArea(boundary);
            if (area >= 1.0) {
              foundRooms.push(boundary);
            }
          }
          continue;
        }
        if (!path.includes(next)) {
          dfs(start, next, [...path, next], depth + 1);
        }
      }
    };

    for (const startNode of adj.keys()) {
      dfs(startNode, startNode, [startNode], 0);
    }

    // Deduplicate by centroid proximity (1 m)
    let roomIdCounter = geometry.rooms.length;
    for (const boundary of foundRooms) {
      const cx = boundary.reduce((s, p) => s + p.x, 0) / boundary.length;
      const cy = boundary.reduce((s, p) => s + p.y, 0) / boundary.length;
      const alreadyCovered = geometry.rooms.some(r => {
        const rx = r.boundaries.reduce((s, p) => s + p.x, 0) / r.boundaries.length;
        const ry = r.boundaries.reduce((s, p) => s + p.y, 0) / r.boundaries.length;
        return Math.hypot(rx - cx, ry - cy) < 1.0;
      });
      if (!alreadyCovered) {
        geometry.rooms.push({
          id:         `room-auto-${++roomIdCounter}`,
          name:       `Room ${roomIdCounter}`,
          boundaries: boundary,
          area:       this.polygonArea(boundary),
          floor:      'ground',
        });
      }
    }
  }

  // ── Private: room name assignment from TEXT entities ──────────────────────

  /**
   * For every TEXT / MTEXT entity, find the nearest room whose centroid is
   * within 5 m and update its name.
   */
  private assignRoomNamesFromText(
    geometry: DWGGeometry,
    entities: DxfEntity[],
    scale: number,
    bbox: BoundingBox,
  ): void {
    const textEntities = entities.filter(
      e => e.type === 'TEXT' || e.type === 'MTEXT',
    );

    for (const te of textEntities) {
      const rawText = (te.text ?? '').trim();
      if (!rawText) continue;

      // TEXT entity uses startPoint; MTEXT uses position
      const ins = te.startPoint ?? te.position ?? te.insertionPoint;
      if (!ins) continue;

      const tx = ins.x * scale - bbox.minX;
      const ty = ins.y * scale - bbox.minY;

      let closest: (typeof geometry.rooms)[0] | null = null;
      let minDist = 5.0; // max search radius (metres)

      for (const room of geometry.rooms) {
        const cx = room.boundaries.reduce((s, p) => s + p.x, 0) / room.boundaries.length;
        const cy = room.boundaries.reduce((s, p) => s + p.y, 0) / room.boundaries.length;
        const d  = Math.hypot(cx - tx, cy - ty);
        if (d < minDist) {
          minDist  = d;
          closest  = room;
        }
      }

      if (closest && /^[A-Z]/.test(rawText)) {
        // Only override auto-generated names or same-layer names
        closest.name = rawText;
      }
    }
  }

  // ── Private: heuristic fallback ────────────────────────────────────────────

  /**
   * When the standard extraction pipeline fails, fall back to treating ALL
   * LINE entities longer than 0.5 m as walls.  Returns best-effort geometry.
   */
  private heuristicFallback(entities: DxfEntity[], scale: number): DWGGeometry {
    this.logger.warn('Using heuristic fallback: treating long LINE entities as walls');
    const geometry = this.emptyGeometry();
    let   id       = 0;

    // Build a temporary bounding box
    const allPts: Point2D[] = [];
    entities.forEach(e => this.entityPoints(e).forEach(p => allPts.push(p)));
    const minX = allPts.length ? Math.min(...allPts.map(p => p.x)) * scale : 0;
    const minY = allPts.length ? Math.min(...allPts.map(p => p.y)) * scale : 0;

    for (const entity of entities) {
      if (entity.type !== 'LINE') continue;
      const verts = entity.vertices ?? [];
      if (verts.length < 2) continue;

      const x1 = verts[0].x * scale - minX;
      const y1 = verts[0].y * scale - minY;
      const x2 = verts[1].x * scale - minX;
      const y2 = verts[1].y * scale - minY;

      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.5) continue; // too short to be a wall

      geometry.walls.push({
        id:        `wall-heuristic-${++id}`,
        points:    [{ x: x1, y: y1, z: 0 }, { x: x2, y: y2, z: 0 }],
        thickness: 0.2,
        height:    3.0,
        material:  entity.layer ?? 'heuristic',
      });
    }

    return geometry;
  }

  // ── Private: utility helpers ───────────────────────────────────────────────

  /** Extract all meaningful 2D/3D points from any DXF entity for bbox computation. */
  private entityPoints(entity: DxfEntity): Point2D[] {
    const pts: Point2D[] = [];
    // LINE, LWPOLYLINE, POLYLINE → vertices[]
    if (entity.vertices)       entity.vertices.forEach(v => pts.push({ x: v.x, y: v.y }));
    // TEXT → startPoint (MTEXT → position, handled below)
    if (entity.startPoint)     pts.push({ x: entity.startPoint.x, y: entity.startPoint.y });
    // ARC, CIRCLE → center
    if (entity.center)         pts.push({ x: entity.center.x, y: entity.center.y });
    // INSERT, MTEXT, POINT → position
    if (entity.position)       pts.push({ x: entity.position.x, y: entity.position.y });
    return pts;
  }

  /**
   * Sample an ARC into a polyline of up to 32 points.
   * @param startRad - start angle in RADIANS (dxf-parser converts degrees→radians)
   * @param endRad   - end angle in RADIANS
   */
  private arcToPoints(
    cx: number, cy: number,
    radius: number,
    startRad: number,
    endRad: number,
    segments = 32,
  ): Point2D[] {
    const pts: Point2D[] = [];
    let start = startRad;
    let end   = endRad;
    if (end < start) end += Math.PI * 2;
    const step = (end - start) / segments;
    for (let i = 0; i <= segments; i++) {
      const a = start + i * step;
      pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
    return pts;
  }

  /** Shoelace formula for polygon area (metres²). */
  private polygonArea(pts: Point2D[]): number {
    let area = 0;
    const n  = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[i].x * pts[j].y;
      area -= pts[j].x * pts[i].y;
    }
    return Math.abs(area / 2);
  }

  /** Convert a layer name like "A-ROOM-CONF" → "Conference Room". */
  private layerToRoomName(layer: string): string {
    const parts = layer.split('-').filter(p => !['A', 'S', 'I', 'E', 'M', 'P'].includes(p));
    return parts.map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(' ') || 'Room';
  }

  /** Return an empty DWGGeometry scaffold. */
  private emptyGeometry(): DWGGeometry {
    return {
      walls:     [],
      doors:     [],
      windows:   [],
      rooms:     [],
      stairs:    [],
      furniture: [],
    };
  }
}