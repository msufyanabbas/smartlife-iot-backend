/**
 * Diagnostic: run the real DXF parser and mesh factory over a drawing and
 * print what came out.
 *
 * Not a guard — it asserts nothing. It exists because every question about the
 * 3D model ("why are there no doors?", "why is that wall wrong?") is a question
 * about counts and classifications that are invisible from the source, and
 * reading the parser to guess at them is how the last round of floor-plan bugs
 * got shipped.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/probe-geometry.ts <file.dxf> [...]
 */
import { readFileSync } from 'fs';

import { DxfFloorPlanParser } from '../src/modules/floor-plans/parsers/dxf-floor-plan.parser';
import { FloorPlanMeshFactory } from '../src/modules/floor-plans/mesh/floor-plan-mesh.factory';
import { CadStandardsService } from '../src/modules/cad-standards/cad-standards.service';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: probe-geometry.ts <file.dxf> [...]');
  process.exit(1);
}

const standards = new CadStandardsService();

for (const file of files) {
  // latin1, not utf8: DXF is byte-oriented and a stray high byte in a comment
  // must not become a replacement character mid-parse.
  const content = readFileSync(file, 'latin1');
  const g = DxfFloorPlanParser.parse(content);

  console.log(`\n═══════════ ${file} ═══════════`);
  console.log('walls      :', g.walls.length);
  console.log('rooms      :', g.rooms.length);
  console.log('doors      :', g.doors.length);
  console.log('windows    :', g.windows.length);
  console.log('columns    :', g.columns.length);
  console.log('stairs     :', g.stairs.length);
  console.log('devices    :', g.devices.length);
  console.log('bbox       :', JSON.stringify(g.boundingBox));
  console.log('units      :', g.units, 'scale', g.scale);

  console.log('\n-- layers by entity count, with the standard\'s verdict --');
  const sorted = [...g.layers].sort((a, b) => b.entityCount - a.entityCount);
  for (const layer of sorted.slice(0, 26)) {
    let verdict = '';
    try {
      const c = standards.classify(layer.name, layer.linetype);
      verdict = `${c.role}/${c.solid} [${c.basis}]`;
    } catch (error) {
      verdict = `classify threw: ${(error as Error).message}`;
    }
    console.log(
      `   ${layer.name.padEnd(22)} ${String(layer.entityCount).padStart(5)}  ` +
        `${(layer.linetype ?? '').padEnd(12)} ${verdict}`,
    );
  }

  const result = FloorPlanMeshFactory.build(g as any, {});
  console.log('\n-- mesh stats --');
  console.log(JSON.stringify(result.stats, null, 2));
  if (result.warnings?.length) {
    console.log('-- warnings --');
    for (const w of result.warnings.slice(0, 20)) console.log('   !', w);
    if (result.warnings.length > 20) {
      console.log(`   … ${result.warnings.length - 20} more`);
    }
  }
}

// ── Display geometry: what the VIEWER should receive ────────────────────────
import { buildDisplayGeometry } from '../src/modules/floor-plans/display/display-geometry';

for (const file of files) {
  const g = DxfFloorPlanParser.parse(readFileSync(file, 'latin1'));
  const d = buildDisplayGeometry(g as any, {});
  console.log(`\n═══ DISPLAY GEOMETRY: ${file} ═══`);
  console.log(JSON.stringify(d.stats, null, 2));
  console.log('wall segments by thickness:');
  const byT = new Map<string, number>();
  for (const s of d.walls) {
    const k = `${s.thickness.toFixed(3)}m (${s.thicknessSource})`;
    byT.set(k, (byT.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byT].sort()) console.log(`   ${k.padEnd(28)} ${n}`);
  console.log('openings:');
  for (const o of d.openings.slice(0, 8)) {
    console.log(`   ${o.kind.padEnd(7)} w=${o.width.toFixed(2)} h=${o.height.toFixed(2)} sill=${o.sill.toFixed(2)} rot=${o.rotation.toFixed(1)}° wall=${o.wallId ?? 'UNMATCHED'}`);
  }
  console.log('voids:');
  for (const v of d.voids) {
    console.log(`   ${v.kind} ${v.area.toFixed(1)}m² at (${v.center.x.toFixed(1)},${v.center.y.toFixed(1)}) layer=${v.layer}`);
  }
  console.log('bounds:', JSON.stringify(d.bounds));
}
