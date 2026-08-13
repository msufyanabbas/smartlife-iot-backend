// src/modules/floor-plans/dwg-parser.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createCanvas } from 'canvas';
import { DWGGeometry } from '@common/interfaces/index.interface';
import { DxfFloorPlanParser } from './parsers/dxf-floor-plan.parser';

const execAsync = promisify(exec);

interface Point2D { x: number; y: number }

/**
 * File-level owner of the DWG/DXF pipeline.
 *
 * Responsibilities kept here: locating and reading the file, converting DWG →
 * DXF, validating the result, and rendering a thumbnail.
 *
 * Entity classification and 3D geometry construction now live in
 * `parsers/dxf-floor-plan.parser.ts` (DxfFloorPlanParser), which expands BLOCK
 * references, resolves bulges to arcs, and emits every coordinate in metres.
 */
@Injectable()
export class DWGParserService {
  private readonly logger = new Logger(DWGParserService.name);

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Parse a DWG or DXF file and return normalised geometry.
   *
   * Pipeline:
   *   1. Detect file type
   *   2. If .dwg → convert to .dxf with libredwg `dwg2dxf` (or ODA / WSL)
   *   3. Hand the DXF text to DxfFloorPlanParser
   *   4. Return the geometry; never throws — returns empty geometry on failure
   */
  async parseDWGFile(filePath: string): Promise<DWGGeometry> {
    this.logger.log(`parseDWGFile → ${filePath}`);

    let dxfPath = filePath;
    let tempDxf = false;

    try {
      await fs.access(filePath);
    } catch {
      this.logger.error(`File not found: ${filePath}`);
      return this.emptyGeometry();
    }

    try {
      if (filePath.toLowerCase().endsWith('.dwg')) {
        dxfPath = filePath.replace(/\.dwg$/i, '_converted.dxf');
        tempDxf = true;
        await this.convertDwgToDxf(filePath, dxfPath);
      }

      const dxfText = await fs.readFile(dxfPath, 'utf-8');
      const geometry = DxfFloorPlanParser.parse(dxfText);

      const m = geometry.metrics.entityCount;
      this.logger.log(
        `Parsing complete: ${geometry.walls.length} walls, ` +
          `${geometry.doors.length} doors, ${geometry.windows.length} windows, ` +
          `${geometry.columns.length} columns, ${geometry.rooms.length} rooms, ` +
          `${geometry.stairs.length} stairs — ` +
          `${m.total} entities (${m.expanded} from expanded blocks) on ` +
          `${geometry.layers.length} layer(s); units=${geometry.units} scale=${geometry.scale}; ` +
          `extents ${geometry.boundingBox.width}×${geometry.boundingBox.height} m`,
      );

      return geometry;
    } catch (err: any) {
      this.logger.error(`parseDWGFile failed: ${err.message}`, err.stack);
      return this.emptyGeometry();
    } finally {
      if (tempDxf) {
        await fs.unlink(dxfPath).catch(() => {
          /* ignore */
        });
      }
    }
  }

  /**
   * Decide whether a parsed drawing is usable.
   *
   * The only failure condition is an unreadable file — one that yielded no
   * geometry of any kind. Missing walls or missing rooms are NOT failures:
   * plenty of valid DXFs (bridges, site plans, schematics, anything not drawn
   * to the AIA layer standard) contain neither, and rejecting them was making
   * the platform refuse files that parsed perfectly well.
   *
   * Structural oddities are reported as `warnings` and never block the import.
   */
  validateGeometry(geometry: DWGGeometry): {
    valid: boolean;
    errors: string[];
    warnings: string[];
    entityCount: number;
  } {
    const warnings: string[] = [];

    geometry.walls?.forEach((wall, i) => {
      if (!wall.points || wall.points.length < 2) {
        warnings.push(`Wall[${i}] (id=${wall.id}) has fewer than 2 points`);
      }
    });

    geometry.doors?.forEach((door, i) => {
      if (door.width <= 0 || door.height <= 0) {
        warnings.push(`Door[${i}] (id=${door.id}) has invalid dimensions`);
      }
    });

    if (!geometry.walls?.length) warnings.push('No walls found in drawing');
    if (!geometry.rooms?.length) warnings.push('No rooms identified in drawing');

    const entityCount =
      (geometry.walls?.length ?? 0) +
      (geometry.rooms?.length ?? 0) +
      (geometry.doors?.length ?? 0) +
      (geometry.windows?.length ?? 0) +
      (geometry.columns?.length ?? 0) +
      (geometry.stairs?.length ?? 0) +
      (geometry.furniture?.length ?? 0) +
      (geometry.arcs?.length ?? 0) +
      (geometry.circles?.length ?? 0) +
      (geometry.texts?.length ?? 0);

    const errors =
      entityCount === 0
        ? [
            'The file could not be read: no geometry of any kind was found ' +
              '(no lines, polylines, arcs, circles or text).',
          ]
        : [];

    return { valid: entityCount > 0, errors, warnings, entityCount };
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
   *   - Grey columns
   *
   * @returns The output file path (same as `outputPath` argument).
   */
  async generateThumbnail(geometry: DWGGeometry, outputPath: string): Promise<string> {
    const W = 800, H = 600, PADDING = 40;

    try {
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // ── Compute geometry bounding box ─────────────────────────────────────
      const allPoints: Point2D[] = [];
      geometry.walls.forEach(w => w.points.forEach(p => allPoints.push(p)));
      geometry.rooms.forEach(r => r.boundaries.forEach(p => allPoints.push(p)));

      if (allPoints.length === 0) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
        return outputPath;
      }

      let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
      for (const p of allPoints) {
        if (p.x < gMinX) gMinX = p.x; if (p.x > gMaxX) gMaxX = p.x;
        if (p.y < gMinY) gMinY = p.y; if (p.y > gMaxY) gMaxY = p.y;
      }
      const gW = gMaxX - gMinX || 1;
      const gH = gMaxY - gMinY || 1;

      const sc = Math.min((W - PADDING * 2) / gW, (H - PADDING * 2) / gH);

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

        const label = room.label ?? room.name;
        if (label) {
          ctx.fillStyle = '#334155';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, px(room.center.x), py(room.center.y));
        }
      });

      // ── Walls ─────────────────────────────────────────────────────────────
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 2;
      geometry.walls.forEach(wall => {
        if (wall.points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(px(wall.points[0].x), py(wall.points[0].y));
        wall.points.slice(1).forEach(p => ctx.lineTo(px(p.x), py(p.y)));
        ctx.stroke();
      });

      // ── Columns ───────────────────────────────────────────────────────────
      ctx.fillStyle = '#94a3b8';
      geometry.columns?.forEach(col => {
        const w = Math.max(2, col.width * sc);
        const h = Math.max(2, col.height * sc);
        ctx.fillRect(px(col.position.x) - w / 2, py(col.position.y) - h / 2, w, h);
      });

      // ── Doors (swing arc where we have one) ───────────────────────────────
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      geometry.doors.forEach(door => {
        if (door.swing) {
          const r = door.swing.radius * sc;
          const cx = px(door.swing.center.x);
          const cy = py(door.swing.center.y);
          // Canvas Y is flipped, so the sweep runs the other way.
          ctx.beginPath();
          ctx.arc(cx, cy, r,
            (-door.swing.startAngle * Math.PI) / 180,
            (-door.swing.endAngle * Math.PI) / 180,
            true);
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          return;
        }
        const dpx = px(door.position.x);
        const dpy = py(door.position.y);
        const dw = door.width * sc;
        ctx.save();
        ctx.translate(dpx, dpy);
        ctx.rotate((-door.rotation * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(-dw / 2, 0);
        ctx.lineTo(dw / 2, 0);
        ctx.stroke();
        ctx.restore();
      });

      // ── Windows ───────────────────────────────────────────────────────────
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      geometry.windows.forEach(win => {
        ctx.beginPath();
        ctx.moveTo(px(win.start.x), py(win.start.y));
        ctx.lineTo(px(win.end.x), py(win.end.y));
        ctx.stroke();
      });

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
    const outDir = path.dirname(dxfPath);

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
    const odaFromEnv = process.env.ODA_CONVERTER_PATH;
    const odaCandidates = [
      odaFromEnv,
      'C:\\Program Files\\ODA\\ODAFileConverter 25.6.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 24.12.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 24.6.0\\ODAFileConverter.exe',
      'C:\\Program Files\\ODA\\ODAFileConverter 23.12.0\\ODAFileConverter.exe',
      'ODAFileConverter',
    ].filter(Boolean) as string[];

    for (const odaExe of odaCandidates) {
      const exePath = odaExe.endsWith('.exe') || !odaExe.includes('\\')
        ? odaExe
        : path.join(odaExe, 'ODAFileConverter.exe');

      try {
        // ODA CLI: ODAFileConverter <inputFolder> <outputFolder> <version> <fileType> <recurse> <audit> [filter]
        const dwgDir = path.dirname(dwgPath);
        const dwgBase = path.basename(dwgPath, '.dwg');

        const odaCmd = `"${exePath}" "${dwgDir}" "${outDir}" ACAD2018 DXF 0 1 "${dwgBase}.dwg"`;
        this.logger.log(`Trying ODA File Converter: ${odaCmd}`);

        const { stderr } = await execAsync(odaCmd, { timeout: 120_000 });
        if (stderr) this.logger.warn(`ODA stderr: ${stderr}`);

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
        ].join('\n')
      : [
          'DWG→DXF conversion failed. Install libredwg:',
          '  Ubuntu/Debian: sudo apt-get install libredwg-utils',
          '  macOS:         brew install libredwg',
        ].join('\n');

    throw new Error(instructions);
  }

  // ── Private: utility ───────────────────────────────────────────────────────

  /** Return an empty geometry scaffold matching the parser's output shape. */
  private emptyGeometry(): DWGGeometry {
    return {
      walls: [], rooms: [], doors: [], windows: [], columns: [],
      stairs: [], furniture: [],
      layers: [], layerNames: [],
      boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      building: {
        floorHeight: 3.0,
        hasElevationData: false,
        elevationRange: { min: 0, max: 0 },
        minElevation: 0,
        maxElevation: 0,
        totalArea: 0,
      },
      units: 'unitless',
      scale: 1,
      metrics: {
        entityCount: {
          lines: 0, polylines: 0, arcs: 0, circles: 0, inserts: 0,
          texts: 0, hatches: 0, solids: 0, expanded: 0, total: 0,
        },
      },
      lines: [], arcs: [], circles: [], texts: [],
      entityCounts: {},
      totalEntities: 0,
    };
  }
}
