/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The CAD standard, encoded
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Transcribed from the two reference drawings:
 *   • CAD_Standards_Master_Template.dxf  — sections 1-11: line weights,
 *     linetypes, text heights, sheet sizes, scales, layer naming, numbering,
 *     the symbol legend and the practice rules.
 *   • CAD_Standards_Drawing_Library.dxf  — sheets LIB-01..LIB-05: wall types,
 *     materials, columns, doors, windows, lifts, ramps, stairs in plan,
 *     stair design rules, and the 3D modelling rules.
 *
 * Declarative on purpose, exactly like `integration-catalogue.ts` and
 * `rule-node-catalogue.ts`: the importer, the 3D builder, the compliance
 * report and the frontend legend all read this one table. Adding a layer to
 * the standard is an entry here and nothing else.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE RULE THAT MATTERS MOST FOR 3D
 * ═════════════════════════════════════════════════════════════════════════
 *
 * A floor plan is full of things that are DRAWN but are not THERE: grid
 * lines, dimension strings, room tags, hatch patterns, section marks, the
 * title block, anything on a non-plot layer, and anything above the cut
 * plane. Extruding those produces a model full of phantom walls where the
 * drawing only had annotation.
 *
 * So every layer declares `solid`:
 *   'build'   → becomes geometry
 *   'void'    → becomes an OPENING cut into the host wall (doors, windows)
 *   'ignore'  → contributes nothing; the space stays empty
 *
 * That is the generalisation of "if the standard says X is empty space, the
 * 3D model must show empty space there". The standard says it by layer.
 */

/** What a layer's geometry becomes in the 3D model. */
export type SolidBehaviour = 'build' | 'void' | 'ignore';

/** The semantic role the 3D builder switches on. */
export type CadRole =
  | 'wall'
  | 'partition'
  | 'curtain_wall'
  | 'door'
  | 'window'
  | 'column'
  | 'beam'
  | 'slab'
  | 'ceiling'
  | 'stair'
  | 'stair_above'
  | 'railing'
  | 'ramp'
  | 'lift'
  | 'escalator'
  | 'floor_fixture'
  | 'furniture'
  | 'room_label'
  | 'level'
  | 'device'
  | 'cable'
  | 'annotation'
  | 'grid'
  | 'hatch'
  | 'hidden'
  | 'section'
  | 'viewport'
  | 'reserved';

export interface LayerRule {
  /** Layer key WITHOUT the status suffix, e.g. `A-WALL-PRTN`. */
  layer: string;
  role: CadRole;
  solid: SolidBehaviour;
  description: string;
  /** Default thickness in mm when the drawing gives no other clue. */
  thicknessMm?: number;
  /** Default height in mm above FFL. */
  heightMm?: number;
  /** Height of the opening's underside (sill) in mm, for windows. */
  sillMm?: number;
  /** Why it is ignored — surfaced verbatim in the compliance report. */
  ignoreReason?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// WALL TYPES — LIB-01 section B, "WALL TYPES IN PLAN (cut at 1.0-1.2 m
// above FFL)". Thicknesses are the drawing's own labels.
// ════════════════════════════════════════════════════════════════════════════

const WALL_RULES: LayerRule[] = [
  { layer: 'A-WALL', role: 'wall', solid: 'build', thicknessMm: 200,
    description: 'Architectural wall. RC 200 is the library default.' },
  { layer: 'A-WALL-PRTN', role: 'partition', solid: 'build', thicknessMm: 125,
    description: 'Drywall partition 125 — 2 x 12.5 GB + 75 stud @ 600.' },
  { layer: 'A-WALL-CURT', role: 'curtain_wall', solid: 'build', thicknessMm: 50,
    description: 'Curtain wall — mullions @ 1500 + glass line.' },
  { layer: 'A-WALL-EXST', role: 'wall', solid: 'build', thicknessMm: 200,
    description: 'Existing wall to remain — thin outline, no hatch.' },
  { layer: 'A-WALL-DEMO', role: 'wall', solid: 'ignore',
    description: 'Wall to be demolished — dashed.',
    ignoreReason:
      'Marked for demolition. It is drawn so the contractor knows what to ' +
      'remove, so building it would model the state BEFORE the works.' },
  { layer: 'A-WALL-PATT', role: 'hatch', solid: 'ignore',
    description: 'Wall hatch pattern.',
    ignoreReason:
      'A hatch is a fill showing the material of a wall drawn on another ' +
      'layer. Extruding it would duplicate that wall as a solid block.' },
];

// ════════════════════════════════════════════════════════════════════════════
// OPENINGS — these are the literal "empty space" case. A door is not a solid
// and it is not nothing: it is a VOID in the wall that hosts it.
// Widths from LIB-02 section F/G.
// ════════════════════════════════════════════════════════════════════════════

const OPENING_RULES: LayerRule[] = [
  { layer: 'A-DOOR', role: 'door', solid: 'void', heightMm: 2100,
    description:
      'Door opening. Library leaf widths: single 900, double 1800, ' +
      'sliding 1800, pocket 900, bi-fold 1800, revolving D2000.' },
  { layer: 'A-GLAZ', role: 'window', solid: 'void', heightMm: 1500, sillMm: 900,
    description: 'Glazing / window opening, cut between sill and head.' },
];

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURE
// ════════════════════════════════════════════════════════════════════════════

const STRUCTURE_RULES: LayerRule[] = [
  { layer: 'A-COLS', role: 'column', solid: 'build', thicknessMm: 400,
    description: 'Architectural column. Library default RC 400x400.' },
  { layer: 'S-COLS', role: 'column', solid: 'build', thicknessMm: 400,
    description: 'Structural column.' },
  { layer: 'A-COLS-PATT', role: 'hatch', solid: 'ignore',
    description: 'Column hatch / poche.',
    ignoreReason: 'Fill pattern for a column drawn on A-COLS or S-COLS.' },
  { layer: 'S-BEAM', role: 'beam', solid: 'ignore',
    description: 'Beam above — drawn dashed.',
    ignoreReason:
      'A beam is above the 1200 cut plane. It belongs to the ceiling of ' +
      'this level, not its floor; building it at floor level puts a block ' +
      'in mid-air across the room.' },
  { layer: 'A-CLNG', role: 'ceiling', solid: 'ignore',
    description: 'Reflected ceiling.',
    ignoreReason:
      'A reflected ceiling plan is drawn looking UP, above the 1200 cut ' +
      'plane. Its grid would land on the floor if it were built here.' },
];

// ════════════════════════════════════════════════════════════════════════════
// CIRCULATION — LIB-03/04/05.
//
// "3D MODELLING - a stair is NOT a wall" is stated three separate times in
// the library, with the modelling recipe spelled out: draw the side profile
// as one closed polyline, ROTATE3D 90 about X, EXTRUDE by the width. The
// importer honours that by giving stairs their own role rather than letting
// them fall through to the wall extruder.
// ════════════════════════════════════════════════════════════════════════════

const CIRCULATION_RULES: LayerRule[] = [
  { layer: 'A-FLOR-STRS', role: 'stair', solid: 'build', heightMm: 175,
    description:
      'Stair treads below the cut plane. Riser 175 / going 280 is the ' +
      'library flight; a stair is modelled as a stair, never as walls.' },
  { layer: 'A-FLOR-STRS-ABOV', role: 'stair_above', solid: 'ignore',
    description: 'Stair flight ABOVE the cut plane — dashed 0.18.',
    ignoreReason:
      'Explicitly the part of the stair above 1200. It is shown so the ' +
      'reader knows the stair continues; it is not on this floor.' },
  { layer: 'A-FLOR-STRS-ARRW', role: 'annotation', solid: 'ignore',
    description: 'Stair direction arrow (dot = first riser, UP / DN).',
    ignoreReason: 'An annotation arrow, not a physical object.' },
  { layer: 'A-FLOR-HRAL', role: 'railing', solid: 'build', heightMm: 1070,
    description: 'Handrail / guard. Guard 1070 at open sides; handrail 865-965.' },
  { layer: 'A-FLOR-EVTR', role: 'lift', solid: 'build',
    description: 'Lift / elevator — car, counterweight, shaft walls, 900 landing door.' },
  { layer: 'A-FLOR-ESCL', role: 'escalator', solid: 'build',
    description: 'Escalator — 30 degrees, 800 step, comb plates both ends.' },
  { layer: 'A-FLOR-LEVL', role: 'level', solid: 'ignore',
    description: 'Level / FFL marker.',
    ignoreReason:
      'A datum flag stating a finished floor level, e.g. FFL +2.800. The ' +
      'VALUE is read as the storey height; the marker itself is not built.' },
  { layer: 'A-FLOR-FIXT', role: 'floor_fixture', solid: 'build', heightMm: 900,
    description: 'Floor-mounted fixture.' },
  { layer: 'A-FURN', role: 'furniture', solid: 'build', heightMm: 750,
    description: 'Furniture.' },
];

// ════════════════════════════════════════════════════════════════════════════
// THE A-3D-* FAMILY
//
// These are the one unambiguous signal in the whole standard: the library's
// sheet LIB-05 puts finished 3D geometry on its own layers. When a drawing
// has them, they are authoritative and the plan geometry is a duplicate of
// the same thing.
// ════════════════════════════════════════════════════════════════════════════

const THREE_D_RULES: LayerRule[] = [
  { layer: 'A-3D-WALL', role: 'wall', solid: 'build', thicknessMm: 200,
    description: '3D wall solid.' },
  { layer: 'A-3D-SLAB', role: 'slab', solid: 'build', thicknessMm: 150,
    description: '3D slab / landing. Waist slab 150 measured perpendicular.' },
  { layer: 'A-3D-STRS', role: 'stair', solid: 'build',
    description: '3D stair solid — one solid per flight.' },
  { layer: 'A-3D-PROF', role: 'stair', solid: 'build',
    description:
      'Closed stair side profile. Rotated 90 about X and extruded by the ' +
      'stair width (1200) to make the flight.' },
  { layer: 'A-3D-HRAL', role: 'railing', solid: 'build', heightMm: 900,
    description: '3D handrail — swept D40 circle at 900 above the nosings.' },
];

// ════════════════════════════════════════════════════════════════════════════
// ANNOTATION, GRID AND NON-PLOT — everything here is ignored.
// ════════════════════════════════════════════════════════════════════════════

const ANNOTATION_RULES: LayerRule[] = [
  { layer: 'G-ANNO-TEXT', role: 'annotation', solid: 'ignore',
    description: 'General notes and text.',
    ignoreReason:
      'Note text. Letter outlines are closed polylines, so extruding this ' +
      'layer builds the words themselves as solid objects.' },
  { layer: 'G-ANNO-DIMS', role: 'annotation', solid: 'ignore', description: 'Dimension lines and leaders.', ignoreReason:
      'A dimension string. The leaders and witness lines would extrude ' +
      'into thin walls running off the edge of every room.' },
  { layer: 'G-ANNO-SYMB', role: 'annotation', solid: 'ignore',
    description: 'North arrow, section marks, callouts.',
    ignoreReason:
      'Navigation symbols that tell the reader how to use the sheet. They ' +
      'describe the drawing, not the building it depicts.' },
  { layer: 'G-ANNO-TTLB', role: 'annotation', solid: 'ignore',
    description: 'Title block.',
    ignoreReason:
      'The project/client/revision panel on the sheet border. It is ' +
      'metadata about the drawing, printed on every sheet.' },
  { layer: 'G-ANNO-REVS', role: 'annotation', solid: 'ignore',
    description: 'Revision table and clouds.',
    ignoreReason:
      'Revision clouds mark WHERE a drawing changed between issues. They ' +
      'are review markup and are removed at construction issue.' },
  { layer: 'G-ANNO-NPLT', role: 'annotation', solid: 'ignore',
    description: 'Non-plotting construction geometry.',
    ignoreReason:
      'The NPLT minor group means it is not even printed. If it is not on ' +
      'the paper it is certainly not in the building.' },
  { layer: 'G-GRID', role: 'grid', solid: 'ignore',
    description: 'Structural grid — dash-dot 0.18, bubbles D500 at 1:50.',
    ignoreReason:
      'Setting-out lines. They run the full width of the plan, so ' +
      'extruding them would wall off every room along the grid.' },
  { layer: 'G-VPRT', role: 'viewport', solid: 'ignore',
    description: 'Layout viewport frames.',
    ignoreReason:
      'The rectangle framing a view on a sheet. It lives in paper space and ' +
      'has no position in the building at all.' },
  { layer: 'VIEWPORTS', role: 'viewport', solid: 'ignore',
    description: 'AutoCAD\'s default viewport layer.',
    ignoreReason:
      'Not an NCS name, but it is what AutoCAD creates for layout ' +
      'viewports and both reference drawings use it. A viewport is a ' +
      'window onto model space, not anything in the building.' },
  { layer: 'A-ANNO-TEXT', role: 'annotation', solid: 'ignore',
    description: 'Architectural notes.',
    ignoreReason:
      'Note text on the architectural sheets — the same reason as ' +
      'G-ANNO-TEXT: letterforms would become solids.' },
  { layer: 'A-ANNO-SYMB', role: 'annotation', solid: 'ignore',
    description: 'Architectural symbols.',
    ignoreReason:
      'Sheet symbols — elevation markers, detail bubbles, break lines. ' +
      'They are notation, not fabric.' },
  { layer: 'A-AREA-IDEN', role: 'room_label', solid: 'ignore',
    description: 'Room / area identification — name and area.',
    ignoreReason:
      'A room tag. It is read for the room NAME, which is kept as metadata, ' +
      'but it is not geometry.' },
  { layer: 'A-HIDN', role: 'hidden', solid: 'ignore',
    description: 'Hidden / above-cut objects, dashed 0.18.',
    ignoreReason: 'Hidden geometry — by definition not visible at this level.' },
  { layer: 'A-ELEV', role: 'section', solid: 'ignore',
    description: 'Elevation markers.',
    ignoreReason:
      'A pointer to another drawing — it says where an elevation is taken ' +
      'from and does not exist on site.' },
  { layer: 'A-SECT-MCUT', role: 'section', solid: 'ignore',
    description: 'Material cut in section, 0.70.',
    ignoreReason:
      'Geometry belonging to a SECTION view, drawn elsewhere on the sheet. ' +
      'In plan coordinates it would land in the wrong place entirely.' },
  { layer: 'A-SECT-MBND', role: 'section', solid: 'ignore',
    description: 'Material beyond the cut, 0.18.',
    ignoreReason:
      'Things visible behind a section cut, drawn thin. Same problem as ' +
      'A-SECT-MCUT: section coordinates, not plan coordinates.' },
  { layer: 'A-SECT-PATT', role: 'hatch', solid: 'ignore',
    description: 'Section hatch.',
    ignoreReason:
      'Material poche inside an element drawn on another layer. Building ' +
      'it would duplicate that element as a block of hatch lines.' },
  { layer: 'DEFPOINTS', role: 'reserved', solid: 'ignore',
    description: 'AutoCAD dimension definition points.',
    ignoreReason:
      'Never plots. The template states: "Do not draw on layer 0 or ' +
      'Defpoints in model space."' },
  { layer: '0', role: 'reserved', solid: 'ignore',
    description: 'Layer 0 — reserved for block definitions.',
    ignoreReason:
      'The template states blocks are DRAWN on layer 0 but nothing should ' +
      'be drawn there in model space, so content here is unclassifiable.' },
];

// ════════════════════════════════════════════════════════════════════════════
// SERVICES — devices and cabling. Geometry on these layers is a symbol
// standing for equipment, never a wall.
// ════════════════════════════════════════════════════════════════════════════

const SERVICE_LAYERS: Array<[string, CadRole, string]> = [
  ['T-CCTV', 'device', 'CCTV cameras'],
  ['T-CCTV-FOVW', 'annotation', 'CCTV field of view — dotted coverage'],
  ['T-ACCS', 'device', 'Access control'],
  ['T-INTR', 'device', 'Intercom'],
  ['T-DATA', 'device', 'Data outlets'],
  ['T-DATA-CABL', 'cable', 'Data cabling'],
  ['T-DATA-FIBR', 'cable', 'Fibre'],
  ['T-WIFI', 'device', 'Wireless access points'],
  ['T-RACK', 'device', 'Racks and cabinets'],
  ['T-PAGE', 'device', 'Paging / PA speakers'],
  ['T-IPTV', 'device', 'IPTV'],
  ['T-CTRY', 'device', 'Clock / time systems'],
  ['FA-DEVC', 'device', 'Fire alarm devices'],
  ['FA-PANL', 'device', 'Fire alarm panels'],
  ['FA-WIRE', 'cable', 'Fire alarm wiring'],
  ['E-LITE', 'device', 'Light fittings'],
  ['E-LITE-CIRC', 'cable', 'Lighting circuits'],
  ['E-LTNG-KNX', 'device', 'KNX devices'],
  ['E-POWR', 'device', 'Power outlets'],
  ['E-POWR-CIRC', 'cable', 'Power circuits'],
  ['E-POWR-PANL', 'device', 'Distribution boards'],
  ['E-GRND', 'cable', 'Earthing'],
  ['B-CTRL-DEVC', 'device', 'BMS field devices'],
  ['B-CTRL-PANL', 'device', 'BMS controllers'],
  ['B-CTRL-WIRE', 'cable', 'BMS wiring'],
  ['M-HVAC-EQPM', 'device', 'HVAC equipment'],
  ['M-HVAC-SUPP', 'cable', 'HVAC supply ductwork'],
  ['M-HVAC-RETN', 'cable', 'HVAC return ductwork'],
  ['M-CHIL', 'device', 'Chilled water plant'],
  ['P-DOMW', 'cable', 'Domestic water'],
  ['P-SANR', 'cable', 'Sanitary drainage'],
  ['F-PROT-SPRN', 'device', 'Sprinklers'],
];

const SERVICE_RULES: LayerRule[] = SERVICE_LAYERS.map(([layer, role, description]) => ({
  layer,
  role,
  solid: 'ignore' as SolidBehaviour,
  description,
  ignoreReason:
    role === 'cable'
      ? 'A cable or duct route — a line showing where a service runs, not a solid.'
      : 'An equipment symbol. It is captured as a DEVICE PLACEMENT rather than ' +
        'geometry, so it appears in the model as a device marker, not a block.',
}));

export const LAYER_RULES: LayerRule[] = [
  ...WALL_RULES,
  ...OPENING_RULES,
  ...STRUCTURE_RULES,
  ...CIRCULATION_RULES,
  ...THREE_D_RULES,
  ...ANNOTATION_RULES,
  ...SERVICE_RULES,
];

export const LAYER_RULE_INDEX: Map<string, LayerRule> = new Map(
  LAYER_RULES.map((r) => [r.layer.toUpperCase(), r]),
);

// ════════════════════════════════════════════════════════════════════════════
// SYMBOL BLOCKS — the legend in master template section 9, with the layer
// each block belongs on. A block name is a far stronger signal than geometry.
// ════════════════════════════════════════════════════════════════════════════

export interface SymbolRule {
  block: string;
  layer: string;
  label: string;
  /** Maps onto this platform's own device vocabulary where one fits. */
  deviceHint?: string;
}

export const SYMBOL_RULES: SymbolRule[] = [
  { block: 'SYM-CCTV-DOME', layer: 'T-CCTV', label: 'CCTV dome camera', deviceHint: 'camera' },
  { block: 'SYM-CCTV-BULLET', layer: 'T-CCTV', label: 'CCTV bullet camera', deviceHint: 'camera' },
  { block: 'SYM-ACS-READER', layer: 'T-ACCS', label: 'Card / biometric reader', deviceHint: 'access_reader' },
  { block: 'SYM-ACS-MAGLOCK', layer: 'T-ACCS', label: 'Magnetic lock', deviceHint: 'lock' },
  { block: 'SYM-ACS-EXIT', layer: 'T-ACCS', label: 'Exit push button', deviceHint: 'button' },
  { block: 'SYM-INTERCOM', layer: 'T-INTR', label: 'Video intercom station', deviceHint: 'intercom' },
  { block: 'SYM-DATA-OUTLET', layer: 'T-DATA', label: 'Data outlet (RJ45)', deviceHint: 'data_outlet' },
  { block: 'SYM-WIFI-AP', layer: 'T-WIFI', label: 'Wireless access point', deviceHint: 'access_point' },
  { block: 'SYM-RACK', layer: 'T-RACK', label: 'Data rack / cabinet', deviceHint: 'rack' },
  { block: 'SYM-SPEAKER-CEIL', layer: 'T-PAGE', label: 'Ceiling speaker (PA/BGM)', deviceHint: 'speaker' },
  { block: 'SYM-SMOKE-DET', layer: 'FA-DEVC', label: 'Smoke detector', deviceHint: 'smoke_sensor' },
  { block: 'SYM-HEAT-DET', layer: 'FA-DEVC', label: 'Heat detector', deviceHint: 'temperature_sensor' },
  { block: 'SYM-MCP', layer: 'FA-DEVC', label: 'Manual call point', deviceHint: 'button' },
  { block: 'SYM-SOUNDER', layer: 'FA-DEVC', label: 'Sounder / beacon', deviceHint: 'siren' },
  { block: 'SYM-KNX-KEYPAD', layer: 'E-LTNG-KNX', label: 'KNX keypad / switch', deviceHint: 'switch' },
  { block: 'SYM-KNX-PRESENCE', layer: 'E-LTNG-KNX', label: 'KNX presence sensor', deviceHint: 'motion_sensor' },
  { block: 'SYM-BMS-TEMP', layer: 'B-CTRL-DEVC', label: 'Temperature sensor', deviceHint: 'temperature_sensor' },
  { block: 'SYM-BMS-HUMID', layer: 'B-CTRL-DEVC', label: 'Humidity sensor', deviceHint: 'humidity_sensor' },
  { block: 'SYM-BMS-DDC', layer: 'B-CTRL-PANL', label: 'DDC controller', deviceHint: 'controller' },
  { block: 'SYM-LIGHT', layer: 'E-LITE', label: 'Light fitting', deviceHint: 'light' },
  { block: 'SYM-SOCKET-DBL', layer: 'E-POWR', label: 'Twin socket outlet', deviceHint: 'socket' },
];

export const SYMBOL_INDEX: Map<string, SymbolRule> = new Map(
  SYMBOL_RULES.map((s) => [s.block.toUpperCase(), s]),
);

// ════════════════════════════════════════════════════════════════════════════
// DIMENSIONAL RULES — LIB-04 section L, "STAIR DESIGN RULES (check your local
// code)". The library cites IBC/IRC and notes Saudi Building Code SBC 201
// follows the IBC. All values in millimetres.
// ════════════════════════════════════════════════════════════════════════════

export interface DimensionRule {
  key: string;
  label: string;
  min?: number;
  max?: number;
  unit: 'mm' | 'deg' | 'ratio';
  note: string;
}

export const DIMENSION_RULES: DimensionRule[] = [
  { key: 'stair.riser', label: 'Riser', min: 100, max: 180, unit: 'mm',
    note: 'IBC max 178; dwellings max 196 (IRC).' },
  { key: 'stair.going', label: 'Going / tread', min: 280, unit: 'mm',
    note: 'IBC min 279; dwellings min 254 (IRC).' },
  { key: 'stair.comfort', label: '2R + G (Blondel)', min: 600, max: 650, unit: 'mm',
    note: 'Pitch 30-35 degrees for comfort.' },
  { key: 'stair.pitch', label: 'Pitch', max: 42, unit: 'deg',
    note: 'Max ~42 dwellings, ~38 public.' },
  { key: 'stair.uniformity', label: 'Riser/tread uniformity', max: 10, unit: 'mm',
    note: 'Largest minus smallest within a flight (IBC); +/- 5 mm target.' },
  { key: 'stair.clearWidth', label: 'Clear width', min: 1120, unit: 'mm',
    note: 'IBC 1118 for >50 occupants; 915 below.' },
  { key: 'stair.headroom', label: 'Headroom', min: 2030, unit: 'mm',
    note: 'Measured from the pitch line (IBC 2032).' },
  { key: 'stair.risePerFlight', label: 'Rise per flight', max: 3660, unit: 'mm',
    note: 'Between landings (IBC 12 ft). UK: max 16 risers per flight.' },
  { key: 'stair.landingDepth', label: 'Landing depth', min: 1120, unit: 'mm',
    note: 'At least the stair width; need not exceed 1220 in a straight run.' },
  { key: 'stair.nosing', label: 'Nosing projection', min: 19, max: 32, unit: 'mm',
    note: 'With closed risers (IBC).' },
  { key: 'handrail.height', label: 'Handrail height', min: 865, max: 965, unit: 'mm',
    note: 'Above the nosing line; extend 305 horizontally at top, one tread at bottom.' },
  { key: 'handrail.grip', label: 'Handrail grip diameter', min: 32, max: 51, unit: 'mm',
    note: 'Clear of the wall by 38 minimum.' },
  { key: 'guard.height', label: 'Guard height', min: 1070, unit: 'mm',
    note: 'At open sides (IBC 42 in). No opening a 100 sphere can pass.' },
  { key: 'ramp.gradient', label: 'Ramp gradient', max: 0.0833, unit: 'ratio',
    note: 'Max 1:12 (8.33%).' },
  { key: 'ramp.risePerRun', label: 'Ramp rise per run', max: 760, unit: 'mm', note: 'Then a landing.' },
  { key: 'ramp.landing', label: 'Ramp landing length', min: 1525, unit: 'mm', note: 'Clear width 915.' },
  { key: 'door.single', label: 'Single swing door', min: 900, unit: 'mm', note: 'Library default leaf.' },
  { key: 'plan.cutPlane', label: 'Plan cut plane', min: 1000, max: 1500, unit: 'mm',
    note: 'Above FFL. The library draws at 1200.' },
];

export const DIMENSION_INDEX: Map<string, DimensionRule> = new Map(
  DIMENSION_RULES.map((d) => [d.key, d]),
);

// ════════════════════════════════════════════════════════════════════════════
// LINE WEIGHTS AND LINETYPES — master template sections 2 and 3. The importer
// uses linetype as a SECONDARY signal: a dashed line on an otherwise solid
// layer is hidden or above-cut geometry.
// ════════════════════════════════════════════════════════════════════════════

export const LINE_WEIGHTS = [
  { mm: 0.13, use: 'Hatching, very fine detail, non-plot reference' },
  { mm: 0.18, use: 'Dimension lines, leaders, grid, background, door swings, distant objects' },
  { mm: 0.25, use: 'Thin — text, symbols, circuits, hidden, fixtures, furniture, handrails' },
  { mm: 0.35, use: 'Medium — devices, equipment outlines, elements below the cut' },
  { mm: 0.5, use: 'Thick — walls and columns cut in plan, panels, border' },
  { mm: 0.7, use: 'Extra thick — section cut outlines, title frame' },
  { mm: 1.0, use: 'Emphasis — outer sheet border, key plan' },
] as const;

export const LINETYPES = [
  { name: 'CONTINUOUS', use: 'Visible outlines, devices, walls', impliesHidden: false },
  { name: 'ISO-DASHED', use: 'Hidden edges, objects ABOVE the cut plane, cable routes', impliesHidden: true },
  { name: 'ISO-DASHDOT', use: 'Centre lines, grid, axes, fibre', impliesHidden: true },
  { name: 'ISO-DASHDOTDOT', use: 'Phantom, plot/property boundaries, earthing', impliesHidden: true },
  { name: 'ISO-DOTTED', use: 'Field of view, coverage, existing, future', impliesHidden: true },
] as const;

/** Linetype names that mean "drawn, but not solid at this level". */
export const HIDDEN_LINETYPES: ReadonlySet<string> = new Set<string>(
  LINETYPES.filter((l) => l.impliesHidden).map((l) => l.name as string),
);

// ════════════════════════════════════════════════════════════════════════════
// PRACTICE RULES — master template section 11. Checked by the validator.
// ════════════════════════════════════════════════════════════════════════════

export const PRACTICE_RULES = [
  'Draw everything at 1:1 in model space (1 unit = 1 mm). Never scale geometry to fit paper.',
  'Annotate and plot from layouts (paper space) at 1:1 through scaled viewports.',
  'Colour, linetype and lineweight = BYLAYER. Draw blocks on layer 0.',
  'Do not draw on layer 0 or Defpoints in model space.',
  'Use XREFs for architectural backgrounds; bind only at final issue.',
  'Use annotative text / dimensions, or DIMSCALE = drawing scale.',
  'PURGE and AUDIT before issue; set UCS to World; zoom extents before saving.',
] as const;

/** Units: the standard is millimetres throughout. */
export const STANDARD_UNITS = 'mm' as const;

/** Default storey height when the drawing carries no level information. */
export const DEFAULT_FLOOR_TO_FLOOR_MM = 3150;

/** The plan cut plane the library draws at. */
export const CUT_PLANE_MM = 1200;

export const REFERENCE_STANDARDS = [
  { code: 'ISO 128 (series)', covers: 'Technical drawings — general principles, line types and widths' },
  { code: 'ISO 129-1', covers: 'Dimensioning and tolerancing' },
  { code: 'ISO 216', covers: 'Paper sizes A0-A4' },
  { code: 'ISO 3098', covers: 'Lettering — character heights' },
  { code: 'ISO 5455', covers: 'Recommended drawing scales' },
  { code: 'ISO 5457', covers: 'Sheet sizes, borders, frames, grid reference' },
  { code: 'ISO 7200', covers: 'Title block data fields' },
  { code: 'ISO 13567', covers: 'CAD layer organisation and naming' },
  { code: 'ISO 19650 / BS 1192', covers: 'Information management, file and drawing numbering' },
  { code: 'ISO 7518 / ISO 4157', covers: 'Construction drawings — simplified representation' },
  { code: 'IEC 60617', covers: 'Graphical symbols for electrical diagrams' },
  { code: 'US NCS v6 (AIA/CSI/NIBS)', covers: 'Layer names, sheet ID, symbols' },
  { code: 'ASME Y14 (series)', covers: 'US mechanical drawing practice' },
  { code: 'NFPA 170', covers: 'Fire safety and emergency symbols' },
] as const;
