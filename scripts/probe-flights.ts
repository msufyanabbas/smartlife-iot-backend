import { readFileSync } from 'fs';
import { DxfFloorPlanParser } from '../src/modules/floor-plans/parsers/dxf-floor-plan.parser';
import { assembleStairFlights } from '../src/modules/floor-plans/mesh/stair-flight';

const g = DxfFloorPlanParser.parse(readFileSync('/home/claude/cad/raw/library.dxf', 'utf8'));
const segs = (g.stairs as any[]).map(s => ({ start: s.points[0], end: s.points[1], layer: s.layer }));
const byLayer = new Map<string, number>();
for (const s of segs) byLayer.set(s.layer, (byLayer.get(s.layer) ?? 0) + 1);
console.log('input segments by layer:', [...byLayer.entries()]);

const r = assembleStairFlights(segs);
console.log(`\nflights=${r.flights.length} orphans=${r.orphans}`);
for (const f of r.flights) {
  console.log(`  ${f.layer.padEnd(20)} steps=${String(f.steps).padStart(3)} run=${f.runLength.toFixed(2)}m width=${f.width.toFixed(2)}m going=${(f.runLength/f.steps*1000).toFixed(0)}mm`);
}
// length distribution of orphan-prone segments
const lens = segs.map(s => Math.hypot(s.end.x-s.start.x, s.end.y-s.start.y)).sort((a,b)=>a-b);
console.log('\nsegment length percentiles (m):',
  [0.05,0.25,0.5,0.75,0.95].map(p => lens[Math.floor(p*(lens.length-1))].toFixed(3)).join(' '));
