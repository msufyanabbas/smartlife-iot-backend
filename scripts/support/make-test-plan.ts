/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Generate a small, realistic architectural DXF to test the import pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The two reference drawings the client supplied are STANDARDS DOCUMENTS — a
 * sheet template and a detail library, 179 m wide with 99 unrelated regions on
 * it. They define the conventions but neither is a floor plan, so neither can
 * answer "does a wall come out as one wall?" or "is there a hole where the
 * door is?".
 *
 * This writes a plan that exercises exactly the conventions that matter, with
 * known-correct answers:
 *
 *   • Walls drawn as TWO PARALLEL LINES per wall — which is how walls are
 *     actually drawn, and the thing the importer has to recognise. A 12×8 m
 *     room with 200 mm external walls is 8 lines, not 4, and must come back as
 *     4 walls of 0.2 m, not 8 walls of 0.1 m.
 *   • A 900 mm door and a 1500 mm window on their standard layers, each
 *     centred on a wall, so an opening either appears in the right place or
 *     does not.
 *   • An X mark over a 3×3 m region — the client's convention for "this space
 *     is empty".
 *   • Noise that MUST NOT become building fabric: a grid line across the whole
 *     plan, a dimension string, a room tag, wall hatching, and a demolished
 *     partition. Every one of them extrudes happily if the standard is not
 *     applied, which is the defect this fixture exists to catch.
 *
 * Units are millimetres at 1:1 in model space, per rule 11 of the client's
 * master template, so the importer's mm→m scaling is exercised too.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/support/make-test-plan.ts out.dxf
 */

interface Entity {
  layer: string;
  kind: 'LINE' | 'LWPOLYLINE' | 'TEXT' | 'CIRCLE';
  points: Array<[number, number]>;
  closed?: boolean;
  text?: string;
  linetype?: string;
}

const entities: Entity[] = [];

const line = (layer: string, a: [number, number], b: [number, number], linetype?: string) =>
  entities.push({ layer, kind: 'LINE', points: [a, b], linetype });

const poly = (layer: string, points: Array<[number, number]>, closed = true) =>
  entities.push({ layer, kind: 'LWPOLYLINE', points, closed });

const text = (layer: string, at: [number, number], value: string) =>
  entities.push({ layer, kind: 'TEXT', points: [at], text: value });

// ── The building: 12 m × 8 m, 200 mm external walls ────────────────────────
//
// Drawn as parallel face pairs, outer ring then inner ring. The importer must
// pair them into four 200 mm walls.
const W = 12000;
const H = 8000;
const T = 200;

// Outer faces
line('A-WALL', [0, 0], [W, 0]);
line('A-WALL', [W, 0], [W, H]);
line('A-WALL', [W, H], [0, H]);
line('A-WALL', [0, H], [0, 0]);
// Inner faces, offset inward by the wall thickness
line('A-WALL', [T, T], [W - T, T]);
line('A-WALL', [W - T, T], [W - T, H - T]);
line('A-WALL', [W - T, H - T], [T, H - T]);
line('A-WALL', [T, H - T], [T, T]);

// ── An internal partition, 100 mm, splitting off a 4 m room ────────────────
const PX = 8000;
const PT = 100;
line('A-WALL-PRTN', [PX, T], [PX, H - T]);
line('A-WALL-PRTN', [PX + PT, T], [PX + PT, H - T]);

// ── A door in the partition and a window in the south wall ─────────────────
//
// Each is drawn as the leaf line plus its swing, on the standard's own layers.
// The door is centred at y = 4000 in the partition; the window at x = 3000 in
// the south wall.
line('A-DOOR', [PX, 3550], [PX, 4450]);          // 900 mm opening
line('A-DOOR', [PX, 3550], [PX + 900, 3550]);    // leaf drawn open at 90°
line('A-GLAZ', [2250, 0], [3750, 0], 'ISO-DASHED'); // 1500 mm window
line('A-GLAZ', [2250, T], [3750, T], 'ISO-DASHED');

// ── Rooms ──────────────────────────────────────────────────────────────────
poly('A-AREA-IDEN', [
  [T, T], [PX, T], [PX, H - T], [T, H - T],
]);
poly('A-AREA-IDEN', [
  [PX + PT, T], [W - T, T], [W - T, H - T], [PX + PT, H - T],
]);

// ── The X mark: "this space is empty" ──────────────────────────────────────
//
// A 3 × 3 m region in the corner of the large room, crossed corner to corner.
// Both diagonals, which is what makes it an X rather than two stray lines.
const XX = 4000, XY = 4000, XS = 3000;
line('A-AREA-IDEN', [XX, XY], [XX + XS, XY + XS]);
line('A-AREA-IDEN', [XX + XS, XY], [XX, XY + XS]);

// ── A real staircase, drawn the way the library draws one ──────────────────
//
// LIB-04's flight: tread lines perpendicular to the direction of travel, so
// walking in +y means each tread runs along x. The parser offers ONE "stair"
// per line, with steps: 0 — grouping them back into a flight is
// `display/stair-flight.ts`.
//
// The numbers are the standard's own library flight and every one of them is
// compliant for a 3 m storey, so a failure is the builder's and not the
// fixture's:
//
//   16 treads, going 280          -> run 4.20 m between first and last tread
//   17 risers over 3.000 m        -> riser 176.5 mm   (rule: 100-180)
//   2R + G = 632.9                             (rule: 600-650)
//   pitch  = atan(176.5/280) = 32.2 deg        (rule: max 42)
//   clear width 1200                           (rule: min 1120)
const STAIR_X0 = 8600, STAIR_X1 = 9800, STAIR_Y0 = 600, STAIR_GOING = 280;
const STAIR_TREADS = 16;
for (let i = 0; i < STAIR_TREADS; i++) {
  const y = STAIR_Y0 + i * STAIR_GOING;
  line('A-FLOR-STRS', [STAIR_X0, y], [STAIR_X1, y]);
}
// The two stringers, along the run. They must NOT be counted as treads.
line('A-FLOR-STRS', [STAIR_X0, STAIR_Y0], [STAIR_X0, STAIR_Y0 + (STAIR_TREADS - 1) * STAIR_GOING]);
line('A-FLOR-STRS', [STAIR_X1, STAIR_Y0], [STAIR_X1, STAIR_Y0 + (STAIR_TREADS - 1) * STAIR_GOING]);
// The direction arrow is an annotation and must contribute nothing.
line('A-FLOR-STRS-ARRW', [9200, STAIR_Y0 + 200], [9200, STAIR_Y0 + 1800]);

// ── Equipment, per the master template's symbol legend ─────────────────────
//
// SYM-LIGHT on E-LITE, and an HVAC unit on M-HVAC-EQPM. These are what the
// floor-plan control widgets bind to.
for (const [x, y] of [[3000, 2000], [3000, 6000], [6000, 4000], [10000, 4000]] as const) {
  entities.push({ layer: 'E-LITE', kind: 'CIRCLE', points: [[x, y]] });
}
entities.push({ layer: 'M-HVAC-EQPM', kind: 'CIRCLE', points: [[10000, 6500]] });
entities.push({ layer: 'B-CTRL-DEVC', kind: 'CIRCLE', points: [[1000, 7000]] });

// ── Noise that must NOT be built ───────────────────────────────────────────
line('G-GRID', [-2000, 4000], [W + 2000, 4000]);           // spans the plan
line('G-GRID', [6000, -2000], [6000, H + 2000]);
line('G-ANNO-DIMS', [0, -800], [W, -800]);                  // dimension string
line('G-ANNO-DIMS', [0, -600], [0, -1000]);                 // witness lines
line('G-ANNO-DIMS', [W, -600], [W, -1000]);
text('A-ANNO-TEXT', [2000, 4000], 'OFFICE 01');             // letters extrude
text('G-ANNO-TEXT', [0, -1600], 'GENERAL NOTE: NOT TO SCALE');
line('A-WALL-PATT', [0, 50], [W, 50]);                      // hatch inside a wall
line('A-WALL-PATT', [0, 100], [W, 100]);
line('A-WALL-DEMO', [5000, T], [5000, H - T]);              // being torn out
line('A-FLOR-STRS-ABOV', [1000, 1000], [2000, 1000], 'ISO-DASHED'); // above cut plane
line('Defpoints', [0, 0], [100, 100]);                      // never plots

// ── Serialise ──────────────────────────────────────────────────────────────

const layers = [...new Set(entities.map((e) => e.layer))];

const out: string[] = [];
const pair = (code: string | number, value: string | number) => {
  out.push(String(code));
  out.push(String(value));
};

pair(0, 'SECTION');
pair(2, 'HEADER');
pair(9, '$INSUNITS');
pair(70, 4); // millimetres
pair(9, '$EXTMIN');
pair(10, -2000); pair(20, -2000); pair(30, 0);
pair(9, '$EXTMAX');
pair(10, W + 2000); pair(20, H + 2000); pair(30, 0);
pair(0, 'ENDSEC');

pair(0, 'SECTION');
pair(2, 'TABLES');
pair(0, 'TABLE');
pair(2, 'LAYER');
pair(70, layers.length);
for (const name of layers) {
  pair(0, 'LAYER');
  pair(2, name);
  pair(70, 0);
  pair(62, 7);
  pair(6, 'Continuous');
}
pair(0, 'ENDTAB');
pair(0, 'ENDTAB');
pair(0, 'ENDSEC');

pair(0, 'SECTION');
pair(2, 'ENTITIES');
for (const e of entities) {
  pair(0, e.kind);
  pair(8, e.layer);
  if (e.linetype) pair(6, e.linetype);

  if (e.kind === 'LINE') {
    pair(10, e.points[0][0]); pair(20, e.points[0][1]); pair(30, 0);
    pair(11, e.points[1][0]); pair(21, e.points[1][1]); pair(31, 0);
  } else if (e.kind === 'LWPOLYLINE') {
    pair(90, e.points.length);
    pair(70, e.closed ? 1 : 0);
    for (const [x, y] of e.points) { pair(10, x); pair(20, y); }
  } else if (e.kind === 'TEXT') {
    pair(10, e.points[0][0]); pair(20, e.points[0][1]); pair(30, 0);
    pair(40, 250);
    pair(1, e.text ?? '');
  } else if (e.kind === 'CIRCLE') {
    pair(10, e.points[0][0]); pair(20, e.points[0][1]); pair(30, 0);
    pair(40, 150);
  }
}
pair(0, 'ENDSEC');
pair(0, 'EOF');

const target = process.argv[2] ?? 'test-plan.dxf';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('fs').writeFileSync(target, out.join('\n') + '\n', 'latin1');
console.log(
  `wrote ${target}: ${entities.length} entities on ${layers.length} layers\n` +
    `expected after import: 4 external walls @ 0.2 m + 1 partition @ 0.1 m,\n` +
    `1 door opening @ 0.9 m, 1 window @ 1.5 m, 2 rooms, 1 void (3×3 m),\n` +
    `6 devices, and NOTHING from G-GRID / G-ANNO-* / A-WALL-PATT /\n` +
    `A-WALL-DEMO / A-FLOR-STRS-ABOV / Defpoints.`,
);
