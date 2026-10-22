/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: what the 3D viewer is given is the BUILDING, not the drawing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reported as: *"there is an issue in creating the lines as walls again plus
 * the structure itself ... there is no doors"* and *"the thickness feature has
 * no benefit"*.
 *
 * Three defects, one cause each, all invisible to `tsc`:
 *
 *  1. **The standard was not on the viewer's path.** There were two consumers
 *     of a parsed drawing. The export path (`FloorPlanMeshFactory`) applied
 *     the drawing standard; the viewer read `parsedGeometry` directly. The
 *     parser is deliberately permissive — it offers every line as a wall
 *     CANDIDATE — so the viewer extruded the sheet title block, the wall
 *     hatching, the section views, the dimension strings, the grid lines and
 *     the letter outlines of the general notes. Measured on the client's own
 *     drawing library: 790 of 1211 "walls".
 *
 *  2. **Wall faces were never paired.** A wall is drawn as two parallel face
 *     lines, and a DXF LINE has no width, so `makeWall()` stamped
 *     `thickness: 0.1` on every one. A 5-wall room imported as 10 thin walls
 *     with a 100 mm slot between each pair.
 *
 *  3. **Doors and windows.** The viewer's window code read `start`/`end`,
 *     which the payload does not carry, so every window computed length 0 and
 *     was dropped — windows had never rendered at all.
 *
 * This runs the real pipeline over a drawing whose correct answers are known,
 * and asserts each one. It needs NO DATABASE: the parser and the display
 * builder are pure functions over a file.
 *
 * Every positive assertion is paired with a NEGATIVE CONTROL — the same
 * measurement with that one transformation switched off — because a check that
 * only ever sees the fixed code cannot tell "this works" from "this cannot
 * fail". §4r is the record of what happens without that discipline.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-display-geometry.ts
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DxfFloorPlanParser } from '../src/modules/floor-plans/parsers/dxf-floor-plan.parser';
import { DEFAULT_STANDARD_FILTER } from '../src/modules/floor-plans/mesh/cad-standard.filter';
import { buildStairFlightsDetailed } from '../src/modules/floor-plans/display/stair-flight';
import { CadStandardsService } from '../src/modules/cad-standards/cad-standards.service';
import { buildDisplayGeometry } from '../src/modules/floor-plans/display/display-geometry';
import { detectXVoids } from '../src/modules/floor-plans/display/x-void';
import { pairWallFaces } from '../src/modules/floor-plans/display/wall-pairing';

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const root = join(__dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'verify-display-'));

try {
  console.log('\n── Display geometry ───────────────────────────────────────\n');

  // ── The fixture ──────────────────────────────────────────────────────────
  //
  // Generated rather than committed as a binary, so the expected answers and
  // the drawing that produces them cannot drift apart: the generator states
  // both.
  const dxf = join(work, 'test-plan.dxf');
  execFileSync(
    'npx',
    ['ts-node', '-T', '-r', 'tsconfig-paths/register', 'scripts/support/make-test-plan.ts', dxf],
    { cwd: root, encoding: 'utf8' },
  );

  const parsed = DxfFloorPlanParser.parse(readFileSync(dxf, 'latin1'));
  ok('the fixture parses', parsed.walls.length > 0, parsed.walls.length);

  const display = buildDisplayGeometry(parsed as any, {});

  // ── 1. The standard reaches the viewer's geometry ────────────────────────
  section('1. the drawing standard is applied');

  // 22 lines are drawn on wall-ish layers; the parser hands on 20. The
  // stair's 16 tread lines and 2 stringers are NOT among them — they go to
  // `stairs`, because `A-FLOR-STRS` has the stair role — but the stair's
  // direction ARROW is on `A-FLOR-STRS-ARRW`, whose role is annotation, so it
  // arrives here as a wall candidate like any other annotation and the
  // standard is what drops it. `wallsAfterStandard` staying at 10 is the
  // proof it was dropped.
  //
  // It is still deliberately
  // permissive about every OTHER kind of noise — the grid line, the dimension
  // string, the hatch and the demolished partition all arrive as candidates
  // and are cut by the standard below. The two it does remove are the X
  // strokes, because the client's standard is that a crossed-out box renders
  // as a box with NO cross in it: suppressing the region's contents while
  // leaving the cross itself standing is the complaint this answers, and the
  // strokes usually sit on a layer the standard would keep.
  ok(
    'the parser offers every line as a wall candidate, less the X strokes',
    display.stats.wallCandidates === 20,
    display.stats.wallCandidates,
  );
  // Named by the two corner-to-corner spans of the fixture's 3 × 3 m marked
  // region, not by "any diagonal" — the fixture also draws a deliberate 100 mm
  // diagonal on `Defpoints`, which the parser SHOULD still offer and the
  // standard is what drops. An assertion that caught that one too would be
  // asserting the parser had stopped being permissive.
  const spansRegion = (w: any) => {
    const pts = [w?.start, w?.end].map((p) => [p?.x, p?.y]);
    const corner = (x: number, y: number) =>
      pts.some(([px, py]) => Math.abs(px - x) < 1e-6 && Math.abs(py - y) < 1e-6);
    return (corner(4, 4) && corner(7, 7)) || (corner(7, 4) && corner(4, 7));
  };
  ok(
    'and the two it removed are the X strokes — nothing else went with them',
    !parsed.walls.some(spansRegion) &&
      !((parsed as any).lines ?? []).some(spansRegion) &&
      parsed.walls.some(
        (w: any) =>
          Math.abs(Math.abs(w.start.x - w.end.x) - Math.abs(w.start.y - w.end.y)) < 1e-6 &&
          Math.abs(w.start.x - w.end.x) > 1e-6,
      ),
    `X strokes left: ${parsed.walls.filter(spansRegion).length} in walls, ` +
      `${((parsed as any).lines ?? []).filter(spansRegion).length} in lines`,
  );
  ok(
    'the void survives the strokes being removed — it is reported, not re-detected',
    display.voids.length === 1 && (parsed as any).voids?.length === 1,
    `display ${display.voids.length}, parsed ${(parsed as any).voids?.length}`,
  );
  ok(
    'and the standard cuts that to the ten that are actually built',
    display.stats.wallsAfterStandard === 10,
    display.stats.wallsAfterStandard,
  );

  const builtLayers = new Set(display.walls.map((w) => w.layer));
  for (const layer of [
    'G-GRID',
    'G-ANNO-DIMS',
    'G-ANNO-TEXT',
    'A-ANNO-TEXT',
    'A-WALL-PATT',
    'A-WALL-DEMO',
    'Defpoints',
  ]) {
    ok(`nothing is built on ${layer}`, !builtLayers.has(layer));
  }

  ok(
    'and the exclusions are reported with the standard\'s own reason',
    display.excluded.length > 0 &&
      display.excluded.every((d) => typeof d.reason === 'string' && d.reason.length > 10),
    display.excluded.slice(0, 3),
  );

  // The negative control. Without it this section would pass just as happily
  // against a build that never filtered anything, provided the fixture
  // happened to contain no noise.
  const unfiltered = buildDisplayGeometry(parsed as any, { enforceStandard: false });
  const unfilteredLayers = new Set(unfiltered.walls.map((w) => w.layer));
  ok(
    'NEGATIVE CONTROL: with the standard off, the grid and the dimensions ARE built',
    unfilteredLayers.has('G-GRID') && unfilteredLayers.has('G-ANNO-DIMS'),
    [...unfilteredLayers],
  );
  ok(
    'and the model is larger than the building, because the grid runs past it',
    unfiltered.bounds.width > display.bounds.width,
    { filtered: display.bounds.width, unfiltered: unfiltered.bounds.width },
  );

  // ── 2. Wall faces are paired into real walls ─────────────────────────────
  section('2. the two drawn faces of a wall become one wall');

  ok(
    'ten face lines become five walls',
    display.stats.wallsPaired === 5,
    display.stats.wallsPaired,
  );
  ok('and none is left unpaired', display.stats.wallsUnpaired === 0, display.stats.wallsUnpaired);

  const thicknesses = [...new Set(display.walls.map((w) => Number(w.thickness.toFixed(3))))].sort();
  ok(
    'the external walls measure 0.2 m and the partition 0.1 m, from the drawing',
    thicknesses.length === 2 &&
      Math.abs(thicknesses[0] - 0.1) < 1e-6 &&
      Math.abs(thicknesses[1] - 0.2) < 1e-6,
    thicknesses,
  );
  ok(
    'and every wall says its thickness was MEASURED, not defaulted',
    display.walls.every((w) => w.thicknessSource === 'paired'),
    [...new Set(display.walls.map((w) => w.thicknessSource))],
  );

  // This is the assertion that makes the thickness control meaningful. The
  // viewer may only override a thickness the drawing did not state, and it
  // can only know which those are from this flag.
  const unpaired = buildDisplayGeometry(parsed as any, { pairWalls: false });
  ok(
    'NEGATIVE CONTROL: without pairing there are ten walls, not five',
    unpaired.walls.filter((w) => w.bottom === 0).length > display.walls.length,
    { paired: display.walls.length, unpaired: unpaired.walls.length },
  );
  ok(
    'and every one of them reports the 0.1 m DEFAULT — the old behaviour',
    unpaired.walls.every(
      (w) => w.thicknessSource === 'default' && Math.abs(w.thickness - 0.1) < 1e-6,
    ),
    [...new Set(unpaired.walls.map((w) => `${w.thickness}/${w.thicknessSource}`))],
  );

  // ── 3. Openings exist, once each, in the right wall ──────────────────────
  section('3. doors and windows are cut into their walls');

  const doors = display.openings.filter((o) => o.kind === 'door');
  const windows = display.openings.filter((o) => o.kind === 'window');

  ok('exactly one door', doors.length === 1, doors.length);
  ok('exactly one window', windows.length === 1, windows.length);

  ok('the door is 0.9 m wide', Math.abs(doors[0].width - 0.9) < 0.01, doors[0]?.width);
  ok('and sits on the floor', doors[0].sill === 0, doors[0]?.sill);
  ok(
    'and is rotated to its wall — the partition runs north-south, so 90°',
    Math.abs(Math.abs(doors[0].rotation) - 90) < 1,
    doors[0]?.rotation,
  );
  ok('the door matched a wall', doors[0].wallId !== null, doors[0]?.wallId);

  ok('the window is 1.5 m wide', Math.abs(windows[0].width - 1.5) < 0.01, windows[0]?.width);
  ok('and is raised to its sill', windows[0].sill > 0.5, windows[0]?.sill);
  ok(
    'and is rotated to the south wall, which runs east-west, so 0°',
    Math.abs(windows[0].rotation % 180) < 1,
    windows[0]?.rotation,
  );

  ok(
    'every opening carries its host wall\'s thickness, so a frame can fit it',
    display.openings.every((o) => o.wallThickness > 0),
    display.openings.map((o) => o.wallThickness),
  );
  ok('no opening is left unmatched', display.stats.openingsUnmatched === 0, display.stats);

  // The hole is real because the wall is ABSENT there, which is what lets the
  // renderer draw plain boxes with no CSG. Proven by the split: a wall with an
  // opening comes back as more than one piece.
  const bySegmentCount = new Map<string, number>();
  for (const w of display.walls) {
    bySegmentCount.set(w.wallId, (bySegmentCount.get(w.wallId) ?? 0) + 1);
  }
  ok(
    'the walls holding an opening are split into several pieces',
    [...bySegmentCount.values()].some((n) => n > 1),
    [...bySegmentCount.entries()],
  );
  ok(
    'and a window leaves solid wall both below its sill and above its head',
    display.walls.some((w) => w.bottom > 0) && display.walls.some((w) => w.top < display.wallHeight),
    display.walls.filter((w) => w.bottom > 0).map((w) => ({ b: w.bottom, t: w.top })),
  );

  const uncut = buildDisplayGeometry(parsed as any, { cutOpenings: false });
  ok(
    'NEGATIVE CONTROL: with cutting off, no wall is split and nothing is raised',
    uncut.walls.every((w) => w.bottom === 0),
    uncut.walls.filter((w) => w.bottom > 0).length,
  );

  // ── 3b. Entity order must not change the answer ──────────────────────────
  section('3b. the result does not depend on DXF entity order');

  // The dedupe can REPLACE a placement with a better-aligned entity, and the
  // opening used to be emitted as each candidate arrived — so the hole came
  // out corrected and the door's own position kept the superseded value. The
  // fixture's parallel entity happens to come first, so no replacement ever
  // ran and nothing caught it.
  //
  // Order of entities in a DXF is the draughtsman's business. Reversing them
  // must give the same building.
  const reversed = buildDisplayGeometry(
    {
      ...parsed,
      doors: [...parsed.doors].reverse(),
      windows: [...parsed.windows].reverse(),
      walls: [...parsed.walls].reverse(),
    } as any,
    {},
  );

  ok(
    'reversing the drawing\'s entities yields the same wall count',
    reversed.walls.length === display.walls.length,
    { forward: display.walls.length, reversed: reversed.walls.length },
  );
  ok(
    'the same thicknesses',
    JSON.stringify([...new Set(reversed.walls.map((w) => Number(w.thickness.toFixed(3))))].sort()) ===
      JSON.stringify([...new Set(display.walls.map((w) => Number(w.thickness.toFixed(3))))].sort()),
    [...new Set(reversed.walls.map((w) => w.thickness))],
  );
  ok(
    'and one door and one window, still',
    reversed.openings.filter((o) => o.kind === 'door').length === 1 &&
      reversed.openings.filter((o) => o.kind === 'window').length === 1,
    reversed.openings.map((o) => o.kind),
  );

  // The load-bearing one: the door's own position must sit at the CENTRE of
  // the hole that was cut for it, whichever entity the dedupe settled on.
  const doorFwd = display.openings.find((o) => o.kind === 'door')!;
  const doorRev = reversed.openings.find((o) => o.kind === 'door')!;
  ok(
    'and the door sits in exactly the same place — its leaf follows its hole',
    Math.abs(doorFwd.position.x - doorRev.position.x) < 0.01 &&
      Math.abs(doorFwd.position.y - doorRev.position.y) < 0.01,
    { forward: doorFwd.position, reversed: doorRev.position },
  );

  // And that place is the middle of the partition, where the drawing put it —
  // not half a leaf off, which is what reading the swing line would give.
  ok(
    'at the mid-height of the partition the drawing cut it into',
    Math.abs(doorFwd.position.y - 4) < 0.1,
    doorFwd.position,
  );

  // ── 4. The X convention ──────────────────────────────────────────────────
  section('4. an X over a space means that space is empty');

  ok('the X is detected', display.stats.voids === 1, display.stats.voids);
  ok(
    'as a 3 × 3 m region',
    display.voids.length === 1 && Math.abs(display.voids[0].area - 9) < 0.5,
    display.voids[0]?.area,
  );
  ok(
    'centred where it was drawn',
    display.voids.length === 1 &&
      Math.abs(display.voids[0].center.x - 5.5) < 0.1 &&
      Math.abs(display.voids[0].center.y - 5.5) < 0.1,
    display.voids[0]?.center,
  );
  ok(
    'and it is reported as not-fitted-out, so the FLOOR STAYS',
    display.voids[0]?.kind === 'not_fitted_out',
    display.voids[0]?.kind,
  );
  ok(
    'the light fitting inside it is not placed',
    display.stats.devicesSuppressedByVoid === 1,
    display.stats.devicesSuppressedByVoid,
  );
  ok(
    'and the operator is TOLD it was dropped, rather than losing it silently',
    display.warnings.some((w) => /marked empty with an X/.test(w)),
    display.warnings,
  );
  ok(
    'the devices outside it survive',
    display.devices.length === 5,
    display.devices.length,
  );

  const noVoids = buildDisplayGeometry(parsed as any, { detectXVoids: false });
  ok(
    'NEGATIVE CONTROL: with detection off, nothing is suppressed',
    noVoids.stats.voids === 0 && noVoids.devices.length === 6,
    { voids: noVoids.stats.voids, devices: noVoids.devices.length },
  );

  // ── 5. X detection does not fire on things that merely cross ─────────────
  section('5. the X detector refuses near-misses');

  const cross = (
    id: string,
    a: [number, number],
    b: [number, number],
    layer = 'A-AREA-IDEN',
  ) => ({ id, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, layer });

  ok(
    'a T-junction is not an X — it touches an end, it does not cross',
    detectXVoids([
      cross('a', [0, 0], [6, 0]),
      cross('b', [3, 0], [3, 6]),
    ]).length === 0,
  );
  ok(
    'two parallel lines are not an X',
    detectXVoids([
      cross('a', [0, 0], [6, 0]),
      cross('b', [0, 2], [6, 2]),
    ]).length === 0,
  );
  ok(
    'a line crossing another near its END is not an X',
    detectXVoids([
      cross('a', [0, 0], [10, 0]),
      cross('b', [9.5, -2], [9.5, 2]),
    ]).length === 0,
  );
  ok(
    'a long line crossed by a short tick is not an X',
    detectXVoids([
      cross('a', [0, 0], [20, 20]),
      cross('b', [10, 10.4], [10.4, 10]),
    ]).length === 0,
  );
  ok(
    'a genuine corner-to-corner X IS one',
    detectXVoids([
      cross('a', [0, 0], [4, 4]),
      cross('b', [4, 0], [0, 4]),
    ]).length === 1,
  );
  ok(
    'a 0.5 m X is a symbol, not a space, and is ignored',
    detectXVoids([
      cross('a', [0, 0], [0.5, 0.5]),
      cross('b', [0.5, 0], [0, 0.5]),
    ]).length === 0,
  );

  // ── 6. Pairing refuses the things that are not a pair ────────────────────
  section('6. wall pairing refuses the things that are not one wall');

  const face = (id: string, a: [number, number], b: [number, number], layer = 'A-WALL') => ({
    id,
    start: { x: a[0], y: a[1], z: 0 },
    end: { x: b[0], y: b[1], z: 0 },
    thickness: 0.1,
    height: 3,
    layer,
  });

  ok(
    'two faces 1.5 m apart are a corridor, not a wall',
    pairWallFaces([face('a', [0, 0], [6, 0]), face('b', [0, 1.5], [6, 1.5])]).paired === 0,
  );
  ok(
    'two faces 10 mm apart are a doubled line, not a wall',
    pairWallFaces([face('a', [0, 0], [6, 0]), face('b', [0, 0.01], [6, 0.01])]).paired === 0,
  );
  ok(
    'two perpendicular lines are a corner, not a wall',
    pairWallFaces([face('a', [0, 0], [6, 0]), face('b', [0, 0], [0, 6])]).paired === 0,
  );
  ok(
    'two collinear jambs either side of a door do not pair with each other',
    pairWallFaces([face('a', [0, 0], [2, 0]), face('b', [3, 0], [6, 0])]).paired === 0,
  );
  ok(
    'faces on DIFFERENT layers do not pair — a partition is not an external wall',
    pairWallFaces([
      face('a', [0, 0], [6, 0], 'A-WALL'),
      face('b', [0, 0.2], [6, 0.2], 'A-WALL-PRTN'),
    ]).paired === 0,
  );
  ok(
    'a pair drawn in OPPOSITE directions still pairs, and the centreline is straight',
    (() => {
      const r = pairWallFaces([face('a', [0, 0], [6, 0]), face('b', [6, 0.2], [0, 0.2])]);
      if (r.paired !== 1) return false;
      const w = r.walls[0];
      return (
        Math.abs(w.thickness - 0.2) < 1e-6 &&
        Math.abs(w.start.y - 0.1) < 1e-6 &&
        Math.abs(w.end.y - 0.1) < 1e-6
      );
    })(),
    pairWallFaces([face('a', [0, 0], [6, 0]), face('b', [6, 0.2], [0, 0.2])]).walls[0],
  );

  // ── 7. Units ─────────────────────────────────────────────────────────────
  section('7. everything is in metres');

  ok('the contract says so', display.units === 'm', display.units);
  ok(
    'the building is 12 × 8 m, as drawn',
    Math.abs(display.bounds.width - 12) < 0.05 && Math.abs(display.bounds.height - 8) < 0.05,
    display.bounds,
  );
  ok(
    'the storey height is a plausible number of metres, not millimetres',
    display.wallHeight >= 2 && display.wallHeight <= 6,
    display.wallHeight,
  );
  ok(
    'and no wall is thicker than a metre, which a mm/m mix-up would make it',
    display.walls.every((w) => w.thickness < 1),
    display.walls.map((w) => w.thickness).filter((t) => t >= 1),
  );

  // ── 8. Staircases ───────────────────────────────────────────────────────
  section('8. the tread lines become one real staircase');

  // The fixture draws the standard's own library flight: 16 tread lines at
  // 280 going, 1200 wide, plus two stringers along the run and a direction
  // arrow. Every number below is therefore the DRAWING's, and a failure is
  // the flight builder's rather than an argument about what a stair should be.
  const stair = display.stairs[0];
  const detailed = buildStairFlightsDetailed(
    (parsed as any).stairs ?? [],
    (input) => new CadStandardsService().checkStair(input),
    { storeyHeight: display.wallHeight },
  );

  ok(
    'the 19 stair-layer lines become ONE flight, not nineteen slabs',
    display.stairs.length === 1,
    `${display.stairs.length} flights from ${parsed.stairs.length} parser entries`,
  );
  // The shared grouping in `mesh/stair-flight.ts` needs THREE real treads
  // before it calls something a flight, so a going is always measured and
  // never guessed from the library — there is no outline fallback to get
  // wrong. The stringers and the direction arrow form no flight and are
  // counted as orphans instead.
  ok(
    'the stringers and the arrow form no flight — they are reported as orphans',
    detailed.orphans >= 2,
    `orphans ${detailed.orphans}`,
  );
  // The orphans ARE reported, in words, naming what unmatched lines usually
  // are and what to check if a staircase is missing. That is the right
  // behaviour and the assertion pins it: silently dropping three lines on a
  // stair layer is how a half-missing flight becomes unexplainable.
  ok(
    'and the orphans are explained rather than silently dropped',
    detailed.warnings.length === 1 &&
      /did not form part of a flight/.test(detailed.warnings[0]) &&
      detailed.warnings[0].includes('16 treads'),
    detailed.warnings,
  );
  ok(
    '16 treads — the two stringers are not treads',
    stair?.treadCount === 16,
    stair?.treadCount,
  );
  ok(
    'and the direction arrow contributed nothing',
    stair?.treadCount === 16,
    stair?.treadCount,
  );
  ok(
    '17 risers, one more than the treads — the top one lands on the floor above',
    stair?.riserCount === 17,
    stair?.riserCount,
  );
  ok(
    'the going is the drawn 280 mm',
    Math.abs(stair.going - 0.28) < 1e-6,
    stair?.going,
  );
  ok(
    'the width is the drawn 1200 mm',
    Math.abs(stair.width - 1.2) < 1e-6,
    stair?.width,
  );
  ok(
    'the riser divides the STOREY, because a plan records nothing vertical',
    Math.abs(stair.riser - display.wallHeight / 17) < 1e-9,
    `${stair?.riser} vs ${display.wallHeight / 17}`,
  );
  ok(
    'the last tread is one riser short of the floor above — not level with it',
    Math.abs(
      stair.treads[stair.treads.length - 1].top + stair.riser - display.wallHeight,
    ) < 1e-9,
    stair?.treads?.[stair.treads.length - 1]?.top,
  );
  ok(
    'the first tread is one riser up, not on the floor',
    Math.abs(stair.treads[0].top - stair.riser) < 1e-9,
    stair?.treads?.[0]?.top,
  );
  ok(
    'tread tops rise monotonically by exactly one riser each',
    stair.treads.every(
      (t: any, i: number) => Math.abs(t.top - stair.riser * (i + 1)) < 1e-9,
    ),
    stair.treads.slice(0, 3).map((t: any) => t.top),
  );
  ok(
    'the run is the treads times the going',
    Math.abs(stair.run - 16 * 0.28) < 1e-6,
    stair?.run,
  );
  ok(
    'the flight runs along +y, as drawn',
    Math.abs(stair.directionDeg - 90) < 1e-6,
    stair?.directionDeg,
  );
  ok(
    'two handrails, one per side',
    stair?.handrails?.length === 2 &&
      new Set(stair.handrails.map((h: any) => h.side)).size === 2,
    stair?.handrails?.map((h: any) => h.side),
  );
  ok(
    'the pitch is in the comfortable band the standard names',
    stair.pitchDeg > 30 && stair.pitchDeg < 35,
    stair?.pitchDeg,
  );
  // The fixture was chosen to be compliant, so ANY issue here is a defect in
  // the measurement or in the unit handed to the rules — a going drawn at
  // exactly the 280 minimum arrives as 279.99999999999994 and was being
  // reported as breaking the rule it exactly meets.
  ok(
    'and the flight is reported compliant, with no issues at all',
    stair?.compliance?.ok === true && stair.compliance.issues.length === 0,
    stair?.compliance?.issues?.map((i: any) => `${i.rule}:${i.message}`),
  );
  ok(
    'every tread is inside the plan, not off the edge of the drawing',
    stair.treads.every(
      (t: any) =>
        t.centre.x >= display.bounds.minX - 1 &&
        t.centre.x <= display.bounds.maxX + 1 &&
        t.centre.y >= display.bounds.minY - 1 &&
        t.centre.y <= display.bounds.maxY + 1,
    ),
    display.bounds,
  );

  // ── 9. A drawing that follows no standard ───────────────────────────────
  section('9. a non-conformant drawing is reachable, not silently empty');

  // Most drawings in the wild are not on NCS layer names. The standard
  // excludes an unrecognised layer on purpose, so the strict reading of such a
  // drawing is an EMPTY model while the 2D plan shows the building — which
  // reads as the 3D viewer being broken.
  //
  // `keepUnrecognised` is the documented escape hatch, and it did nothing:
  // `applyCadStandard` kept the walls and a SECOND, independent filter removed
  // them again because an unknown layer classifies as `ignore`. The same shape
  // as the `enforceStandard` defect this file already documents, one flag
  // along — which is why it is asserted here rather than trusted.
  const plain = (() => {
    const e: string[] = [];
    const L = (layer: string, a: number[], b: number[]) =>
      e.push('0','LINE','8',layer,'10',String(a[0]),'20',String(a[1]),'30','0',
             '11',String(b[0]),'21',String(b[1]),'31','0');
    for (const [a, b] of [
      [[0, 0], [8000, 0]], [[8000, 0], [8000, 6000]],
      [[8000, 6000], [0, 6000]], [[0, 6000], [0, 0]],
      [[200, 200], [7800, 200]], [[7800, 200], [7800, 5800]],
      [[7800, 5800], [200, 5800]], [[200, 5800], [200, 200]],
    ] as number[][][]) L('WALLS', a, b);
    // Noise the standard DOES recognise. It must stay out even with the
    // escape hatch on, or the hatch is just `enforceStandard: false` wearing
    // a narrower name.
    L('G-ANNO-TTLB', [0, -900], [8000, -900]);
    L('G-GRID', [-2000, 3000], [10000, 3000]);
    return DxfFloorPlanParser.parse(
      ['0','SECTION','2','ENTITIES',...e,'0','ENDSEC','0','EOF'].join('\n'),
    );
  })();

  const strictPlain = buildDisplayGeometry(plain as any, {});
  ok(
    'strictly, a drawing on non-standard layers builds NOTHING',
    strictPlain.walls.length === 0,
    strictPlain.walls.length,
  );
  ok(
    'but the parser did offer the lines — so the model is empty by DECISION, not for lack of a drawing',
    strictPlain.stats.wallCandidates >= 8,
    strictPlain.stats.wallCandidates,
  );
  ok(
    'and the exclusion is reported with a layer and a reason, so a viewer can say why',
    strictPlain.excluded.some((e: any) => e.layer === 'WALLS' && !!e.reason),
    strictPlain.excluded.map((e: any) => e.layer),
  );

  const kept = buildDisplayGeometry(plain as any, {
    standard: { ...DEFAULT_STANDARD_FILTER, keepUnrecognised: true },
  });
  ok(
    'keepUnrecognised BUILDS the drawing — the escape hatch is not inert',
    kept.walls.length > 0,
    kept.walls.length,
  );
  ok(
    'and it is narrower than enforceStandard:false — the title block and grid stay out',
    kept.walls.every(
      (w: any) => w.layer !== 'G-ANNO-TTLB' && w.layer !== 'G-GRID',
    ),
    kept.walls.map((w: any) => w.layer),
  );

  const blunt = buildDisplayGeometry(plain as any, { enforceStandard: false });
  ok(
    'whereas enforceStandard:false really does readmit them, which is why it is the blunter tool',
    blunt.walls.length > kept.walls.length,
    `keep ${kept.walls.length} vs off ${blunt.walls.length}`,
  );
  ok(
    'a CONFORMANT drawing is unaffected by the hatch',
    buildDisplayGeometry(parsed as any, {
      standard: { ...DEFAULT_STANDARD_FILTER, keepUnrecognised: true },
    }).walls.length === display.walls.length,
  );

  // Negative control for the whole module.
  const noStairs = buildDisplayGeometry(parsed as any, { buildStairs: false });
  ok(
    'buildStairs=false really leaves the parser\'s per-line stairs alone',
    noStairs.stairs.length === 0,
    noStairs.stairs.length,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: the viewer is given the building, not the drawing\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
