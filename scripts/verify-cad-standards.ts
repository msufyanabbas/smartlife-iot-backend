/**
 * Checks the CAD standard against the two reference drawings it was
 * transcribed from.
 *
 *   npm run verify:cad-standards [path/to/library.dxf] [path/to/master.dxf]
 *
 * No database. The point is that the encoded standard agrees with the
 * drawings a draughtsman is actually handed — if the library puts stairs on
 * `A-FLOR-STRS` and the catalogue calls that a room, every imported model is
 * wrong and nothing in the type system notices.
 */
import { readFileSync, existsSync } from 'fs';
import { CadStandardsService } from '../src/modules/cad-standards/cad-standards.service';
import { parseLayerName } from '../src/modules/cad-standards/ncs-layer';
import {
  HIDDEN_LINETYPES,
  LAYER_RULES,
} from '../src/modules/cad-standards/cad-standard.catalogue';
// Static, not a dynamic import(): ts-node resolves a dynamic one as ESM and
// then demands a file extension the TypeScript source does not have.
import { FloorPlanMeshFactory } from '../src/modules/floor-plans/mesh/floor-plan-mesh.factory';
import { DxfFloorPlanParser } from '../src/modules/floor-plans/parsers/dxf-floor-plan.parser';

const LIB = process.argv[2] ?? '/home/claude/cad/raw/library.dxf';
const MASTER = process.argv[3] ?? '/home/claude/cad/raw/master.dxf';

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};
const section = (t: string) => console.log(`\n── ${t} ─────────────`);

/** Minimal DXF scan: layer names, their entity counts, and block names. */
function scan(path: string) {
  const lines = readFileSync(path, 'latin1').split(/\r?\n/);
  const layerCounts = new Map<string, number>();
  const declaredLayers = new Set<string>();
  const blocks = new Set<string>();
  let sec: string | null = null;
  let pending = false;
  let table: string | null = null;
  let cur: string | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const val = lines[i + 1];
    if (code === '0') {
      if (val === 'SECTION') { pending = true; continue; }
      if (val === 'ENDSEC') { sec = null; table = null; continue; }
      if (sec === 'TABLES' && val === 'TABLE') { table = 'PENDING'; cur = null; continue; }
      cur = sec === 'TABLES' && val === 'LAYER' ? 'LAYER'
          : sec === 'BLOCKS' && val === 'BLOCK' ? 'BLOCK'
          : null;
    } else if (code === '2') {
      if (pending) { sec = val; pending = false; }
      else if (table === 'PENDING') table = val;
      else if (cur === 'LAYER' && table === 'LAYER') declaredLayers.add(val);
      else if (cur === 'BLOCK') blocks.add(val);
    } else if (code === '8' && sec === 'ENTITIES') {
      layerCounts.set(val, (layerCounts.get(val) ?? 0) + 1);
    }
  }
  return { layerCounts, declaredLayers, blocks };
}

(async () => {
  const svc = new CadStandardsService();

  // ── 1. The layer-name grammar ───────────────────────────────────────────
  section('1. NCS layer grammar');
  const p1 = parseLayerName('E-LITE-CIRC-NEWW');
  ok('the template\'s own example parses',
    p1.conformant && p1.discipline === 'E' && p1.major === 'LITE' &&
    p1.minor === 'CIRC' && p1.status === 'NEWW', p1);

  const fa = parseLayerName('FA-DEVC');
  ok('FA is read as fire alarm, not F + A',
    fa.discipline === 'FA' && fa.major === 'DEVC', fa);

  const demo = parseLayerName('A-WALL-DEMO');
  ok('a status suffix is not mistaken for a minor group',
    demo.major === 'WALL' && demo.minor === undefined && demo.status === 'DEMO', demo);

  const abov = parseLayerName('A-FLOR-STRS-ABOV');
  ok('a fourth group that is NOT a status stays as an extra',
    abov.minor === 'STRS' && abov.extra[0] === 'ABOV' && abov.status === 'NEWW', abov);

  ok('layer 0 is flagged, not parsed', !!parseLayerName('0').issue);
  ok('Defpoints is flagged', !!parseLayerName('Defpoints').issue);
  ok('a non-standard name is reported as such', !parseLayerName('MyWalls').conformant);

  // ── 2. The rule the user asked for ──────────────────────────────────────
  section('2. Drawn-but-not-there becomes empty space');
  const mustIgnore: Array<[string, string]> = [
    ['G-GRID', 'grid lines run the full plan width'],
    ['G-ANNO-DIMS', 'dimension strings'],
    ['G-ANNO-TEXT', 'text'],
    ['G-ANNO-NPLT', 'explicitly non-plotting'],
    ['A-ANNO-SYMB', 'drawing symbols'],
    ['A-AREA-IDEN', 'room tags'],
    ['A-WALL-PATT', 'a wall hatch is not a second wall'],
    ['A-COLS-PATT', 'column poche'],
    ['A-WALL-DEMO', 'being demolished'],
    ['A-HIDN', 'hidden'],
    ['Defpoints', 'never plots'],
    ['0', 'reserved'],
    ['A-SECT-MCUT', 'belongs to a section view'],
    ['T-CCTV-FOVW', 'camera coverage, not an object'],
  ];
  for (const [layer, why] of mustIgnore) {
    const c = svc.classify(layer);
    ok(`${layer} → empty space (${why})`, c.solid === 'ignore', c);
    if (c.solid === 'ignore') {
      ok(`   …and says why`, !!c.ignoreReason && c.ignoreReason.length > 20);
    }
  }

  // ── 2b. Present but not a wall ──────────────────────────────────────────
  //
  // These were originally all 'ignore', which was wrong. A light fitting, a
  // camera, a cable tray and a beam are physically in the building; they are
  // simply not building fabric. Collapsing "not a wall" into "not drawn"
  // emptied 34 layers of real equipment out of the model.
  //
  // Above the cut plane is a reason to RAISE geometry, not to drop it.
  section('2b. Equipment and services are built, not discarded');

  const mustMark: Array<[string, string]> = [
    ['T-CCTV', 'ceiling'],
    ['E-LITE', 'ceiling'],
    ['FA-DEVC', 'ceiling'],
    ['F-PROT-SPRN', 'ceiling'],
    ['E-POWR', 'wall'],
    ['T-ACCS', 'wall'],
    ['E-POWR-PANL', 'wall'],
    ['T-RACK', 'floor'],
    ['M-CHIL', 'floor'],
  ];
  for (const [layer, plane] of mustMark) {
    const c = svc.classify(layer);
    ok(`${layer} → device marker on the ${plane}`,
      c.solid === 'marker' && c.mount === plane, c);
    ok(`   …with a size to draw it at`, (c.sizeMm ?? 0) > 0, c.sizeMm);
  }

  const mustRoute: Array<[string, string]> = [
    ['T-DATA-CABL', 'soffit'],
    ['M-HVAC-SUPP', 'soffit'],
    ['E-POWR-CIRC', 'soffit'],
    ['P-DOMW', 'soffit'],
    ['E-GRND', 'floor'],
    ['P-SANR', 'floor'],
  ];
  for (const [layer, plane] of mustRoute) {
    const c = svc.classify(layer);
    ok(`${layer} → service run on the ${plane}`,
      c.solid === 'route' && c.mount === plane, c);
  }

  for (const [layer, role] of [
    ['S-BEAM', 'beam'],
    ['A-CLNG', 'ceiling'],
    ['A-FLOR-STRS-ABOV', 'stair_above'],
  ] as const) {
    const c = svc.classify(layer);
    ok(`${layer} → built at its own height, not dropped`,
      c.solid === 'build' && c.role === role && c.mount !== undefined, c);
  }

  // The regression that made this whole correction necessary: these three
  // layers are specified DASHED by the standard precisely because they are
  // above the cut plane. The hidden-linetype override must not then throw
  // them away — the catalogue already carries the height to build them at.
  for (const lt of ['ISO-DASHED', 'DASHED', 'HIDDEN']) {
    for (const layer of ['S-BEAM', 'A-FLOR-STRS-ABOV']) {
      const c = svc.classify(layer, lt);
      ok(`${layer} survives linetype ${lt}`, c.solid === 'build', c);
    }
    // …while a dashed layer with NO mounting height still drops, because
    // there is nowhere to put it instead.
    const w = svc.classify('A-WALL', lt);
    ok(`a ${lt} wall with no mount is still excluded`, w.solid === 'ignore', w);
  }

  // AutoCAD's stock linetype names must trigger the rule, not just the
  // standard's ISO-* ones. Checking only ISO-DASHED made this assertion pass
  // while the rule never fired on a real drawing at all.
  ok('AutoCAD stock linetype names count as hidden',
    HIDDEN_LINETYPES.has('HIDDEN') && HIDDEN_LINETYPES.has('DASHED') &&
    HIDDEN_LINETYPES.has('ISO-DASHED'));
  ok('…but CONTINUOUS does not', !HIDDEN_LINETYPES.has('CONTINUOUS'));

  // ── 2c. Nothing is modelled through the floor above ─────────────────────
  //
  // The soffit offsets are budgeted against a 450 mm ceiling void. Without
  // this check a 400 mm duct sat at +120 and its top came out 70 mm above
  // the structural slab — a duct running through the storey above.
  section('2c. Every mounted layer fits inside the storey');

  const STOREY = 3.0;
  const CEILING = Math.max(2.1, STOREY - 0.45);
  const mountZ = (c: any, height: number): number => {
    const offset = (c.mountMm ?? 0) / 1000;
    switch (c.mount) {
      case 'ceiling': return Math.max(0, CEILING - offset - height);
      case 'soffit':  return Math.max(0, CEILING + offset);
      case 'wall':
      case 'floor':   return Math.max(0, offset);
      default:        return 0;
    }
  };

  let outside = 0;
  for (const rule of LAYER_RULES) {
    if (rule.mount === undefined) continue;
    const c = svc.classify(rule.layer);
    const size = (c.sizeMm ?? 200) / 1000;
    const h = c.solid === 'route' ? size : (c.heightMm ?? c.sizeMm ?? 200) / 1000;
    const z = mountZ(c, h);
    if (z < 0 || z + h > STOREY + 1e-6) {
      outside++;
      console.log(`      ${rule.layer} z=${z.toFixed(3)} top=${(z + h).toFixed(3)}`);
    }
  }
  ok(`all ${LAYER_RULES.filter((r) => r.mount !== undefined).length} mounted layers sit within a ${STOREY} m storey`,
    outside === 0, { outside });

  section('3. Real fabric becomes geometry');
  for (const layer of ['A-WALL', 'A-WALL-PRTN', 'A-WALL-CURT', 'A-COLS', 'S-COLS',
                       'A-FLOR-STRS', 'A-FLOR-HRAL', 'A-3D-WALL', 'A-3D-SLAB', 'A-3D-STRS']) {
    const c = svc.classify(layer);
    ok(`${layer} → build (${c.role})`, c.solid === 'build', c);
  }

  section('4. Openings are voids, not solids and not nothing');
  for (const layer of ['A-DOOR', 'A-GLAZ']) {
    const c = svc.classify(layer);
    ok(`${layer} → void`, c.solid === 'void', c);
  }
  ok('a window carries a sill height', (svc.classify('A-GLAZ').sillMm ?? 0) > 0);
  ok('a door does not', svc.classify('A-DOOR').sillMm === undefined);

  section('5. Status and linetype override the layer');
  ok('A-WALL-DEMO is ignored even though A-WALL builds',
    svc.classify('A-WALL-DEMO').solid === 'ignore');
  ok('A-WALL-FUTR is ignored', svc.classify('A-WALL-FUTR').solid === 'ignore');
  ok('A-WALL-EXST still builds — it is staying',
    svc.classify('A-WALL-EXST').solid === 'build');
  ok('a DASHED wall is treated as hidden/above',
    svc.classify('A-WALL', 'ISO-DASHED').solid === 'ignore');
  ok('a CONTINUOUS wall still builds',
    svc.classify('A-WALL', 'CONTINUOUS').solid === 'build');

  section('6. Unknown layers are excluded, never guessed');
  const unknown = svc.classify('MY-RANDOM-LAYER');
  ok('an unrecognised layer does not become a wall', unknown.solid === 'ignore');
  ok('an unknown SERVICES layer is still ignored, not walled',
    svc.classify('T-SOMETHING-NEW').solid === 'ignore');
  ok('an unknown A-WALL-* minor still builds as a wall',
    svc.classify('A-WALL-MADEUP').solid === 'build' &&
    svc.classify('A-WALL-MADEUP').basis === 'major-group');

  // ── 7. Against the real drawings ────────────────────────────────────────
  section('7. The two reference drawings');
  for (const [name, path] of [['library', LIB], ['master', MASTER]] as const) {
    if (!existsSync(path)) {
      console.log(`  (skipped ${name} — ${path} not present)`);
      continue;
    }
    const { layerCounts, blocks } = scan(path);
    const report = svc.validate({
      layers: [...layerCounts].map(([nm, n]) => ({ name: nm, entityCount: n })),
      blocks: [...blocks],
      units: 'mm',
    });
    console.log(
      `\n  ${name}: ${report.summary.totalLayers} layers, score ${report.summary.score}%  ` +
      `(build ${report.summary.willBuild}, void ${report.summary.willVoid}, ` +
      `ignore ${report.summary.willIgnore})`,
    );
    ok(`${name}: every layer in the drawing is recognised`,
      report.unrecognised.length === 0,
      report.unrecognised.map((u) => `${u.layer} (${u.entityCount})`));
    ok(`${name}: compliance score is 100%`, report.summary.score === 100,
      report.summary.score);
    if (name === 'library') {
      ok('library: every SYM-* block in the legend is recognised',
        report.symbols.filter((s) => s.block.startsWith('SYM-') && !s.recognised).length === 0,
        report.symbols.filter((s) => s.block.startsWith('SYM-') && !s.recognised).map((s) => s.block));
      ok('library: the A-3D-* layers are all buildable',
        report.layers.filter((l) => l.layer.startsWith('A-3D-')).every((l) => l.solid === 'build'));
    }
  }

  // ── 8. The compliance report is actionable ──────────────────────────────
  section('8. Compliance report on a BAD drawing');
  const bad = svc.validate({
    layers: [
      { name: 'MyWalls', entityCount: 500 },
      { name: '0', entityCount: 40 },
      { name: 'A-WALL', entityCount: 10 },
      { name: 'doors', entityCount: 25 },
    ],
    blocks: ['SYM-CCTV-DOME', 'RANDOM-BLOCK', '*Model_Space'],
    units: 'inches',
  });
  ok('the non-standard layer is listed', bad.unrecognised.some((u) => u.layer === 'MyWalls'));
  ok('…with a suggested replacement',
    bad.unrecognised.find((u) => u.layer === 'MyWalls')?.suggestion === 'A-WALL');
  ok('"doors" is suggested A-DOOR',
    bad.unrecognised.find((u) => u.layer === 'doors')?.suggestion === 'A-DOOR');
  ok('the biggest offender is listed first', bad.unrecognised[0].layer === 'MyWalls');
  ok('wrong units raise a warning', bad.warnings.some((w) => /millimet/i.test(w)));
  ok('drawing on layer 0 raises a warning', bad.warnings.some((w) => /layer 0/i.test(w)));
  ok('the score reflects ENTITIES, not layer names — 10 of 575 is low',
    bad.summary.score < 10, bad.summary.score);
  ok('an anonymous AutoCAD block is not reported as an unknown symbol',
    !bad.symbols.some((s) => s.block.startsWith('*')));
  ok('a real unknown block IS reported',
    bad.symbols.some((s) => s.block === 'RANDOM-BLOCK' && !s.recognised));

  // ── 9. Stair design rules ───────────────────────────────────────────────
  section('9. Stair design rules (LIB-04)');
  const good = svc.checkStair({ riserMm: 175, goingMm: 280, widthMm: 1200, flightRiseMm: 2800 });
  ok("the library's own flight passes (16R@175 / 15G@280)", good.compliant, good.issues);
  ok('…and its pitch matches the drawing\'s stated 32.0 deg',
    Math.abs(good.pitchDeg - 32.0) < 0.3, good.pitchDeg);
  ok('…and 2R+G = 630, inside Blondel', good.blondel === 630);

  const steep = svc.checkStair({ riserMm: 220, goingMm: 200 });
  ok('an over-steep stair fails', !steep.compliant);
  ok('…and the failure cites the rule and the code',
    steep.issues.some((i) => i.rule === 'stair.riser' && /IBC/.test(i.message)), steep.issues);

  // 2R+G = 520, well below Blondel's 600 — a long shallow tread that is
  // legal on every individual dimension but tiring to walk. (An earlier
  // version of this test used 120/400, whose 2R+G is 640 — inside the
  // comfortable band, so it correctly produced no warning at all.)
  const shallow = svc.checkStair({ riserMm: 110, goingMm: 300 });
  ok('an uncomfortable but legal stair warns rather than fails',
    shallow.compliant && shallow.issues.some((i) => i.severity === 'warning'), shallow.issues);

  // ── 10. End to end: does the MODEL actually come out right? ───────────
  //
  // Everything above tests classification. This tests the thing the user
  // asked for: geometry on a "not there" layer must leave EMPTY SPACE in
  // the finished mesh, not a wall.
  section('10. A realistic plan through the mesh builder');
  const seg = (x1: number, y1: number, x2: number, y2: number, layer: string) => ({
    id: `${layer}-${x1}-${y1}`,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    layer,
    thickness: 0.2,
  });

  const plan = {
    // Four real walls making a 10 x 8 room...
    walls: [
      seg(0, 0, 10, 0, 'A-WALL'),
      seg(10, 0, 10, 8, 'A-WALL'),
      seg(10, 8, 0, 8, 'A-WALL'),
      seg(0, 8, 0, 0, 'A-WALL'),
      // ...plus everything a real drawing also contains.
      seg(-2, 4, 12, 4, 'G-GRID'),          // a grid line straight through it
      seg(-2, 2, 12, 2, 'G-ANNO-DIMS'),     // a dimension string
      seg(1, 1, 9, 1, 'A-WALL-PATT'),       // the hatch inside a wall
      seg(2, 2, 8, 2, 'A-WALL-DEMO'),       // a partition being removed
      seg(3, 3, 7, 3, 'S-BEAM'),            // a beam overhead
      seg(4, 1, 4, 7, 'A-HIDN'),            // something hidden
      seg(5, 0, 5, 8, 'MYSTERY-LAYER'),     // a layer nobody documented
    ],
    doors: [{ id: 'd1', position: { x: 5, y: 0 }, width: 0.9, layer: 'A-DOOR' }],
    windows: [{ id: 'w1', position: { x: 10, y: 4 }, width: 1.2, layer: 'A-GLAZ' }],
    rooms: [],
    columns: [],
    stairs: [],
    furniture: [],
    building: { floorHeight: 3 },
  };

  const built = FloorPlanMeshFactory.build(plan as any, { centerOnOrigin: false });

  ok('the four real walls are built, and only those four',
    built.stats.walls === 4, { walls: built.stats.walls });
  ok('the grid line did NOT become a wall through the middle of the room',
    !built.warnings.join(' ').includes('no walls') && built.stats.walls === 4);
  ok('the door survived as an opening, not a solid',
    built.stats.doors === 1 && built.stats.openingsCut >= 1,
    { doors: built.stats.doors, cut: built.stats.openingsCut });
  ok('the window too', built.stats.windows === 1);

  const dropMsg = built.warnings.join('\n');
  for (const layer of ['G-GRID', 'G-ANNO-DIMS', 'A-WALL-PATT', 'A-WALL-DEMO',
                       'A-HIDN', 'MYSTERY-LAYER']) {
    ok(`${layer} was excluded, and the model says so`,
      dropMsg.includes(layer), dropMsg.slice(0, 300));
  }

  // S-BEAM is the counter-example: above the cut plane, so NOT a wall, but
  // still a physical member. It must be built at the soffit rather than
  // excluded — and it must not be counted among the walls.
  ok('S-BEAM is built as a beam, not excluded and not a wall',
    built.stats.beams === 1 && !dropMsg.includes('S-BEAM'),
    { beams: built.stats.beams });
  ok('each exclusion carries a human reason, not just a layer name',
    /Excluded 1 walls on G-GRID \(grid\): .{25,}/.test(dropMsg), dropMsg);

  // The same plan with enforcement off must build the lot — proving the
  // filter is what makes the difference, not some other change.
  const raw = FloorPlanMeshFactory.build(plan as any, {
    centerOnOrigin: false,
    enforceCadStandard: false,
  });
  // 10 walls, not 11: S-BEAM is still lifted to the soffit even with
  // enforcement off. Turning the standard off means "drop nothing", not
  // "put the beams on the floor" — an elevation is a correction, not an
  // exclusion, so it is not something the operator needs to opt out of.
  ok('with the standard turned OFF the linework all becomes geometry (the old behaviour)',
    raw.stats.walls === 10 && raw.stats.beams === 1,
    { walls: raw.stats.walls, beams: raw.stats.beams });
  ok('…which is 6 phantom walls the standard removes',
    raw.stats.walls - built.stats.walls === 6,
    { raw: raw.stats.walls, built: built.stats.walls });

  ok('keepUnrecognisedLayers rescues only the undocumented one',
    FloorPlanMeshFactory.build(plan as any, {
      centerOnOrigin: false, keepUnrecognisedLayers: true,
    }).stats.walls === 5);

  // ── 11. The parser feeds the validator what it needs ──────────────────
  //
  // The compliance report accepts `blocks` and a per-layer `linetype`, and
  // both were unobtainable: the parser recorded a COUNT of inserts and layer
  // records of {name, color, entityCount}. So the symbol half of the report
  // was permanently empty and the dashed-is-hidden rule could never fire.
  section('11. Parser → validator contract');
  if (existsSync(LIB)) {
    {
      const parsed = DxfFloorPlanParser.parse(readFileSync(LIB, 'latin1'));
      ok('the parser now reports block names', Array.isArray(parsed.blocks));
      const syms = (parsed.blocks ?? []).filter((b: string) => b.startsWith('SYM-'));
      ok('…including the SYM-* legend blocks', syms.length > 0, parsed.blocks?.slice(0, 10));
      ok('…and no anonymous AutoCAD blocks',
        !(parsed.blocks ?? []).some((b: string) => b.startsWith('*')));

      ok('layer records carry a linetype field',
        (parsed.layers ?? []).every((l: any) => 'linetype' in l));

      const report = svc.validate({
        layers: (parsed.layers ?? []).map((l: any) => ({
          name: l.name, entityCount: l.entityCount, linetype: l.linetype,
        })),
        blocks: parsed.blocks,
        units: 'mm',
      });
      ok('the symbol section is now populated from a real file',
        report.symbols.length > 0, report.symbols.length);
      ok('…and every SYM-* in it is recognised',
        report.symbols.filter((x) => x.block.startsWith('SYM-') && !x.recognised).length === 0,
        report.symbols.filter((x) => !x.recognised).map((x) => x.block));
      const withHint = report.symbols.filter((x) => x.deviceHint).length;
      ok('…and they map onto device types for placement', withHint > 0, withHint);
    }
  }

  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — the standard matches its reference drawings and drives the import',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
