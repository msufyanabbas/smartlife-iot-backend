/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The SCADA symbol library, declared once on the server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Same pattern and same reason as `modules/rules/rule-node-catalogue.ts` and
 * the integration catalogue: the editor's palette, each symbol's geometry, its
 * named states and the set of properties that may be bound to live data are
 * all read from this table. A symbol hand-written in the frontend drifts from
 * what the runtime renderer understands, and the failure is silent — a state
 * name that no part reacts to saves cleanly and the element then never
 * animates, because an element's `bindings` are a free jsonb column.
 *
 * WHAT A SCADA SYMBOL IS, AND WHAT IT IS NOT
 *
 * The floor-plan viewer already draws device markers and colours them by
 * online/offline. That is a map with status dots. A mimic diagram is a
 * different thing: a schematic of the PROCESS, where each element is a
 * standardised symbol whose appearance is a function of a live measurement —
 * a pump impeller turns while its run feedback is true, a tank's fill tracks a
 * level transmitter, a trip blinks red, a valve body shows open or closed.
 * That is what the `states` and `bindable` fields below exist to express.
 *
 * HOW A SYMBOL ANIMATES
 *
 * Every symbol's `svg` body tags its moving or colour-changing shapes with
 * `data-part="<id>"`. A state names the parts it drives and the style to apply
 * to each:
 *
 *   states: [{ key: 'running', parts: { impeller: { fill: '#22c55e',
 *                                                   spin: 160 } } }]
 *
 * `spin` is degrees per second of continuous rotation about the part's own
 * centre, and `blink` is a period in milliseconds. Neither is a CSS class, so
 * the runtime can drive both from a telemetry value without a stylesheet per
 * symbol — and the editor can show the same animation in its preview.
 *
 * `stateParts` is the set of part ids any state touches. The editor uses it to
 * grey out parts that no state will ever change, and `npm run check:scada`
 * fails when a state names a part the SVG does not contain — the exact drift
 * that produces a symbol that saves fine and then sits still.
 *
 * COORDINATES
 *
 * Each symbol declares its own `viewBox` and is drawn inside it from (0,0).
 * An element on a diagram carries `x`, `y`, `scale` and `rotation`; the
 * renderer wraps the body in `translate(x,y) rotate(r) scale(s)`. Ports are in
 * symbol coordinates, so a connection endpoint survives moving and scaling the
 * element it is attached to.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const SCADA_SYMBOL_CATEGORIES = [
  'pumps',
  'valves',
  'vessels',
  'piping',
  'thermal',
  'rotating',
  'electrical',
  'instruments',
  'hmi',
  'material',
] as const;
export type ScadaSymbolCategory = (typeof SCADA_SYMBOL_CATEGORIES)[number];

/**
 * A property of an element that a binding may drive.
 *
 * `state` is the important one: it resolves a live value to one of the
 * symbol's named states and applies that state's whole part styling in one
 * go. The rest are escape hatches for a diagram that needs to drive a single
 * attribute directly — a label's text, an element's visibility, a free
 * rotation angle — without inventing a state for every possible value.
 */
export const SCADA_BINDABLE_PROPERTIES = [
  'state',
  'fill',
  'stroke',
  'rotation',
  'level',
  'text',
  'visibility',
  'blink',
  'action',
] as const;
export type ScadaBindableProperty =
  (typeof SCADA_BINDABLE_PROPERTIES)[number];

/** Where a binding reads from. */
export const SCADA_BINDING_SOURCES = [
  'telemetry',
  'attribute',
  'alarm',
  'static',
] as const;
export type ScadaBindingSource = (typeof SCADA_BINDING_SOURCES)[number];

/**
 * How a raw value becomes a state, a number or a string.
 *
 *   threshold  numeric → the first band whose test passes
 *   valueMap   discrete → an exact lookup, with a fallback
 *   linear     numeric → rescaled from [inMin,inMax] to [outMin,outMax]
 *   boolean    truthy/falsy → two outputs
 *   format     any → a string, with optional unit and decimal places
 *   passthrough the value, untouched
 */
export const SCADA_TRANSFORM_KINDS = [
  'passthrough',
  'threshold',
  'valueMap',
  'linear',
  'boolean',
  'format',
] as const;
export type ScadaTransformKind = (typeof SCADA_TRANSFORM_KINDS)[number];

export const SCADA_THRESHOLD_OPERATORS = [
  'lt',
  'lte',
  'gt',
  'gte',
  'eq',
  'neq',
  'between',
] as const;
export type ScadaThresholdOperator =
  (typeof SCADA_THRESHOLD_OPERATORS)[number];

export interface ScadaThresholdBand {
  operator: ScadaThresholdOperator;
  value: number;
  /** Only for `between`. */
  value2?: number;
  /** The state key, colour or text this band produces. */
  output: string;
}

export interface ScadaTransform {
  kind: ScadaTransformKind;
  /** `threshold` — evaluated in order; the first match wins. */
  bands?: ScadaThresholdBand[];
  /** `valueMap` — exact match on the stringified value. */
  map?: Record<string, string>;
  /** `valueMap` / `threshold` — used when nothing matches. */
  fallback?: string;
  /** `boolean`. */
  whenTrue?: string;
  whenFalse?: string;
  /** `linear`. */
  inMin?: number;
  inMax?: number;
  outMin?: number;
  outMax?: number;
  /** `linear` — clamp the result into [outMin,outMax]. Default true. */
  clamp?: boolean;
  /** `format`. */
  decimals?: number;
  unit?: string;
  prefix?: string;
}

/** The style a state applies to one part. */
export interface ScadaPartStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  /** Continuous rotation about the part's bounding-box centre, deg/second. */
  spin?: number;
  /**
   * A FIXED angle about the part's own centre, degrees. Distinct from `spin`:
   * a selector knob points somewhere and stays there, a fan blade keeps
   * turning. Both at once is legal and composes — the fixed angle is the
   * starting offset of the sweep.
   */
  rotation?: number;
  /** Blink period in milliseconds. Omitted or 0 means steady. */
  blink?: number;
  visible?: boolean;
  /** Dash-offset animation speed for a flow line, user units/second. */
  flow?: number;
}

export interface ScadaSymbolState {
  key: string;
  label: string;
  /** Guidance only — the editor colours its state chips by this. */
  tone: 'normal' | 'active' | 'warning' | 'fault' | 'idle';
  /** partId → style applied while this state is active. */
  parts: Record<string, ScadaPartStyle>;
  description?: string;
}

export interface ScadaSymbolPort {
  id: string;
  label: string;
  /** Symbol-space coordinates. */
  x: number;
  y: number;
  /** Which way a connection leaves this port, for the elbow router. */
  side: 'left' | 'right' | 'top' | 'bottom';
}

export interface ScadaSymbolManifest {
  key: string;
  label: string;
  category: ScadaSymbolCategory;
  description: string;
  /** lucide-react icon name for the palette row. */
  icon: string;
  /** The symbol's own coordinate system. */
  width: number;
  height: number;
  /** Inline SVG body. Shapes that states drive carry `data-part`. */
  svg: string;
  states: ScadaSymbolState[];
  defaultState: string;
  /** Every part id any state touches. */
  stateParts: string[];
  bindable: ScadaBindableProperty[];
  ports: ScadaSymbolPort[];
  /**
   * For a symbol with a 0–100 level: the `data-part` of the rect the level
   * fills, and the band it moves through in symbol coordinates. The runtime
   * sets that rect's `y` and `height` from the bound value, so the fill rises
   * rather than scaling the whole shape.
   */
  level?: { part: string; top: number; bottom: number };
  /**
   * The other way a 0–100 value can be shown: sweep a part through an arc.
   *
   * A gauge needle does not fill, it points, so a `level` binding on one maps
   * 0–100 onto `fromDeg`…`toDeg` about the part's centre instead of resizing a
   * rect. A symbol declares `level` OR `levelSweep`, never both — the editor
   * shows the same 0–100 form either way and only the renderer differs.
   */
  levelSweep?: { part: string; fromDeg: number; toDeg: number };
  /**
   * A text part whose content a `text` binding replaces.
   *
   * Optional. A `text` binding on a symbol with no text part of its own falls
   * back to the ELEMENT's label, which every element has — so "P-101" becomes
   * "P-101 · 12.4 bar" without every process symbol needing a text slot baked
   * into its geometry.
   */
  textPart?: string;
  /** True for symbols meant to be drawn as a run, not dropped as a box. */
  linear?: boolean;
  /** Search aliases for the palette filter. */
  keywords?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED COLOURS
//
// Literal hex, not Tailwind tokens. `styles/globals.css` in the frontend
// defines its colour tokens as bare HSL triplets with no `hsl()` wrapper, so
// `fill-background` emits `fill: 0 0% 100%`, the browser discards it as
// invalid and SVG falls back to BLACK — the same trap the rule-chain canvas
// documents. A symbol library whose every shape renders black is not a
// cosmetic problem, so the colours live here.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  body: '#cbd5e1',
  bodyEdge: '#475569',
  shell: '#e2e8f0',
  metal: '#94a3b8',
  running: '#22c55e',
  stopped: '#94a3b8',
  fault: '#ef4444',
  warn: '#f59e0b',
  open: '#22c55e',
  closed: '#ef4444',
  partial: '#f59e0b',
  liquid: '#38bdf8',
  liquidHigh: '#ef4444',
  liquidLow: '#f59e0b',
  energised: '#facc15',
  dark: '#334155',
  lampOff: '#64748b',
  text: '#0f172a',
  accent: '#6366f1',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// STATE FACTORIES
//
// Most process equipment has the same three states, and the point of a factory
// is that "running" means the same thing on a pump, a fan and a compressor —
// including the same spin rate and the same blink period on a trip.
// ═══════════════════════════════════════════════════════════════════════════

/** running / stopped / fault, with `rotor` spinning and `body` recoloured. */
const runStopFault = (
  rotor: string,
  body: string,
  spin = 170,
): ScadaSymbolState[] => [
  {
    key: 'running',
    label: 'Running',
    tone: 'active',
    description: 'Run feedback true — the rotating part turns.',
    parts: {
      [body]: { fill: C.running },
      [rotor]: { spin, stroke: '#ffffff' },
    },
  },
  {
    key: 'stopped',
    label: 'Stopped',
    tone: 'idle',
    parts: {
      [body]: { fill: C.stopped },
      [rotor]: { spin: 0, stroke: '#ffffff' },
    },
  },
  {
    key: 'fault',
    label: 'Fault',
    tone: 'fault',
    description: 'Tripped — blinks until acknowledged.',
    parts: {
      [body]: { fill: C.fault, blink: 600 },
      [rotor]: { spin: 0, stroke: '#ffffff' },
    },
  },
];

/** open / closed / partial / fault for a valve whose `disc` recolours. */
const valveStates = (
  disc: string,
  extra?: Record<string, Record<string, ScadaPartStyle>>,
): ScadaSymbolState[] => [
  {
    key: 'open',
    label: 'Open',
    tone: 'active',
    parts: { [disc]: { fill: C.open }, ...(extra?.open ?? {}) },
  },
  {
    key: 'closed',
    label: 'Closed',
    tone: 'idle',
    parts: { [disc]: { fill: C.closed }, ...(extra?.closed ?? {}) },
  },
  {
    key: 'partial',
    label: 'Part open / travelling',
    tone: 'warning',
    parts: { [disc]: { fill: C.partial }, ...(extra?.partial ?? {}) },
  },
  {
    key: 'fault',
    label: 'Fault',
    tone: 'fault',
    parts: {
      [disc]: { fill: C.fault, blink: 600 },
      ...(extra?.fault ?? {}),
    },
  },
];

/** The level states shared by every tank and vessel. */
const levelStates = (liquid: string, shell: string): ScadaSymbolState[] => [
  {
    key: 'normal',
    label: 'Normal',
    tone: 'normal',
    parts: { [liquid]: { fill: C.liquid }, [shell]: { stroke: C.bodyEdge } },
  },
  {
    key: 'low',
    label: 'Low level',
    tone: 'warning',
    parts: { [liquid]: { fill: C.liquidLow }, [shell]: { stroke: C.warn } },
  },
  {
    key: 'high',
    label: 'High level',
    tone: 'fault',
    parts: {
      [liquid]: { fill: C.liquidHigh },
      [shell]: { stroke: C.fault, blink: 800 },
    },
  },
  {
    key: 'empty',
    label: 'Empty',
    tone: 'idle',
    parts: { [liquid]: { opacity: 0 }, [shell]: { stroke: C.bodyEdge } },
  },
];

/** energised / de-energised / fault for electrical gear. */
const powerStates = (
  live: string,
  blinkOnFault = 500,
): ScadaSymbolState[] => [
  {
    key: 'energised',
    label: 'Energised',
    tone: 'active',
    parts: { [live]: { fill: C.running, stroke: C.running } },
  },
  {
    key: 'deenergised',
    label: 'De-energised',
    tone: 'idle',
    parts: { [live]: { fill: C.stopped, stroke: C.bodyEdge } },
  },
  {
    key: 'fault',
    label: 'Trip / fault',
    tone: 'fault',
    parts: {
      [live]: { fill: C.fault, stroke: C.fault, blink: blinkOnFault },
    },
  },
];

const PROCESS_BINDABLE: ScadaBindableProperty[] = [
  'state',
  'fill',
  'rotation',
  'visibility',
  'blink',
  'text',
  'action',
];

const INSTRUMENT_BINDABLE: ScadaBindableProperty[] = [
  'state',
  'fill',
  'text',
  'visibility',
  'blink',
];

// ═══════════════════════════════════════════════════════════════════════════
// THE CATALOGUE
// ═══════════════════════════════════════════════════════════════════════════

const SYMBOLS: ScadaSymbolManifest[] = [
  // ── Pumps ────────────────────────────────────────────────────────────────
  {
    key: 'pump_centrifugal',
    label: 'Centrifugal pump',
    category: 'pumps',
    description:
      'The ISA circle-on-a-plinth pump. The impeller turns while the run feedback is true.',
    icon: 'Fan',
    width: 80,
    height: 72,
    keywords: ['pump', 'centrifugal', 'impeller'],
    svg: `
      <path d="M8 60 L72 60 L62 70 L18 70 Z" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <circle data-part="casing" cx="40" cy="34" r="26" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="impeller">
        <path d="M40 16 A18 18 0 0 1 58 34 L40 34 Z" fill="#ffffff" fill-opacity="0.85"/>
        <path d="M40 52 A18 18 0 0 1 22 34 L40 34 Z" fill="#ffffff" fill-opacity="0.85"/>
      </g>
      <circle cx="40" cy="34" r="4" fill="${C.bodyEdge}"/>
      <rect x="0" y="29" width="10" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="35" y="0" width="10" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: runStopFault('impeller', 'casing'),
    defaultState: 'stopped',
    stateParts: ['casing', 'impeller'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'suction', label: 'Suction', x: 0, y: 34, side: 'left' },
      { id: 'discharge', label: 'Discharge', x: 40, y: 0, side: 'top' },
    ],
  },
  {
    key: 'pump_positive_displacement',
    label: 'Positive-displacement pump',
    category: 'pumps',
    description:
      'Gear / lobe / screw pump. Both lobes counter-rotate while running.',
    icon: 'CircleDot',
    width: 86,
    height: 64,
    keywords: ['pump', 'gear', 'lobe', 'screw', 'dosing'],
    svg: `
      <rect data-part="casing" x="12" y="8" width="62" height="44" rx="6" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="lobeA"><path d="M32 16 L36 30 L28 30 Z M32 44 L28 30 L36 30 Z" fill="#ffffff" fill-opacity="0.9"/></g>
      <g data-part="lobeB"><path d="M54 16 L58 30 L50 30 Z M54 44 L50 30 L58 30 Z" fill="#ffffff" fill-opacity="0.9"/></g>
      <circle cx="32" cy="30" r="2.5" fill="${C.bodyEdge}"/>
      <circle cx="54" cy="30" r="2.5" fill="${C.bodyEdge}"/>
      <rect x="0" y="25" width="12" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="74" y="25" width="12" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: [
      {
        key: 'running',
        label: 'Running',
        tone: 'active',
        parts: {
          casing: { fill: C.running },
          lobeA: { spin: 150 },
          lobeB: { spin: -150 },
        },
      },
      {
        key: 'stopped',
        label: 'Stopped',
        tone: 'idle',
        parts: {
          casing: { fill: C.stopped },
          lobeA: { spin: 0 },
          lobeB: { spin: 0 },
        },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          casing: { fill: C.fault, blink: 600 },
          lobeA: { spin: 0 },
          lobeB: { spin: 0 },
        },
      },
    ],
    defaultState: 'stopped',
    stateParts: ['casing', 'lobeA', 'lobeB'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 30, side: 'left' },
      { id: 'out', label: 'Outlet', x: 86, y: 30, side: 'right' },
    ],
  },

  // ── Rotating machinery ───────────────────────────────────────────────────
  {
    key: 'motor',
    label: 'Electric motor',
    category: 'rotating',
    description:
      'Driver with a shaft. The shaft marker spins while the motor runs.',
    icon: 'Cog',
    width: 84,
    height: 60,
    keywords: ['motor', 'drive', 'driver', 'M'],
    svg: `
      <rect data-part="frame" x="8" y="10" width="54" height="40" rx="5" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <text x="35" y="36" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="700" fill="#ffffff">M</text>
      <rect x="62" y="26" width="16" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <g data-part="shaft"><circle cx="78" cy="30" r="7" fill="none" stroke="${C.bodyEdge}" stroke-width="2"/><line x1="78" y1="23" x2="78" y2="37" stroke="${C.bodyEdge}" stroke-width="2"/></g>
      <rect x="0" y="22" width="8" height="16" fill="${C.dark}"/>
    `,
    states: runStopFault('shaft', 'frame', 220),
    defaultState: 'stopped',
    stateParts: ['frame', 'shaft'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'power', label: 'Supply', x: 0, y: 30, side: 'left' },
      { id: 'shaft', label: 'Shaft', x: 84, y: 30, side: 'right' },
    ],
  },
  {
    key: 'fan',
    label: 'Fan',
    category: 'rotating',
    description: 'Axial fan. Blades rotate while running.',
    icon: 'Fan',
    width: 72,
    height: 72,
    keywords: ['fan', 'axial', 'blower', 'ahu'],
    svg: `
      <circle data-part="ring" cx="36" cy="36" r="30" fill="none" stroke="${C.bodyEdge}" stroke-width="3"/>
      <g data-part="blades">
        <path d="M36 36 L36 10 A26 26 0 0 1 56 24 Z" fill="${C.stopped}"/>
        <path d="M36 36 L58 49 A26 26 0 0 1 36 62 Z" fill="${C.stopped}"/>
        <path d="M36 36 L14 49 A26 26 0 0 1 14 23 Z" fill="${C.stopped}"/>
      </g>
      <circle cx="36" cy="36" r="5" fill="${C.bodyEdge}"/>
    `,
    states: [
      {
        key: 'running',
        label: 'Running',
        tone: 'active',
        parts: { blades: { fill: C.running, spin: 260 }, ring: { stroke: C.running } },
      },
      {
        key: 'stopped',
        label: 'Stopped',
        tone: 'idle',
        parts: { blades: { fill: C.stopped, spin: 0 }, ring: { stroke: C.bodyEdge } },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          blades: { fill: C.fault, spin: 0 },
          ring: { stroke: C.fault, blink: 600 },
        },
      },
    ],
    defaultState: 'stopped',
    stateParts: ['blades', 'ring'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Air in', x: 0, y: 36, side: 'left' },
      { id: 'out', label: 'Air out', x: 72, y: 36, side: 'right' },
    ],
  },
  {
    key: 'compressor',
    label: 'Compressor',
    category: 'rotating',
    description:
      'Rotary compressor with a volute. The rotor turns while loaded.',
    icon: 'Wind',
    width: 88,
    height: 70,
    keywords: ['compressor', 'air', 'screw'],
    svg: `
      <path d="M10 60 L78 60 L78 48 A30 30 0 0 0 10 36 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <circle data-part="volute" cx="40" cy="34" r="24" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="rotor">
        <path d="M40 14 A20 20 0 0 1 60 34 L40 34 Z" fill="#ffffff" fill-opacity="0.8"/>
        <path d="M40 34 L22 46 A20 20 0 0 1 20 34 Z" fill="#ffffff" fill-opacity="0.8"/>
      </g>
      <circle cx="40" cy="34" r="4" fill="${C.bodyEdge}"/>
      <rect x="0" y="29" width="10" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="78" y="40" width="10" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: runStopFault('rotor', 'volute', 300),
    defaultState: 'stopped',
    stateParts: ['volute', 'rotor'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'suction', label: 'Suction', x: 0, y: 34, side: 'left' },
      { id: 'discharge', label: 'Discharge', x: 88, y: 45, side: 'right' },
    ],
  },
  {
    key: 'mixer_agitator',
    label: 'Mixer / agitator',
    category: 'rotating',
    description:
      'Top-entry agitator. The impeller blades turn on the shaft while running.',
    icon: 'Tornado',
    width: 72,
    height: 88,
    keywords: ['mixer', 'agitator', 'stirrer', 'impeller'],
    svg: `
      <rect data-part="drive" x="22" y="0" width="28" height="18" rx="3" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line x1="36" y1="18" x2="36" y2="68" stroke="${C.bodyEdge}" stroke-width="3"/>
      <g data-part="blades">
        <path d="M36 68 L12 62 L12 74 Z" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
        <path d="M36 68 L60 62 L60 74 Z" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      </g>
      <ellipse data-part="swirl" cx="36" cy="82" rx="26" ry="5" fill="none" stroke="${C.liquid}" stroke-width="2" stroke-dasharray="6 5"/>
    `,
    states: [
      {
        key: 'running',
        label: 'Running',
        tone: 'active',
        parts: {
          drive: { fill: C.running },
          blades: { spin: 320 },
          swirl: { stroke: C.liquid, flow: 24 },
        },
      },
      {
        key: 'stopped',
        label: 'Stopped',
        tone: 'idle',
        parts: {
          drive: { fill: C.stopped },
          blades: { spin: 0 },
          swirl: { opacity: 0.3, flow: 0 },
        },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          drive: { fill: C.fault, blink: 600 },
          blades: { spin: 0 },
          swirl: { opacity: 0.2, flow: 0 },
        },
      },
    ],
    defaultState: 'stopped',
    stateParts: ['drive', 'blades', 'swirl'],
    bindable: PROCESS_BINDABLE,
    ports: [{ id: 'power', label: 'Supply', x: 36, y: 0, side: 'top' }],
  },
  {
    key: 'conveyor',
    label: 'Conveyor',
    category: 'material',
    description:
      'Belt conveyor. The belt line animates in the direction of travel while running.',
    icon: 'MoveRight',
    width: 140,
    height: 48,
    keywords: ['conveyor', 'belt', 'transport'],
    svg: `
      <circle cx="18" cy="24" r="14" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <circle cx="122" cy="24" r="14" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <g data-part="belt">
        <line x1="18" y1="10" x2="122" y2="10" stroke="${C.dark}" stroke-width="4" stroke-dasharray="10 8"/>
        <line x1="18" y1="38" x2="122" y2="38" stroke="${C.dark}" stroke-width="4" stroke-dasharray="10 8"/>
      </g>
      <circle data-part="pulley" cx="18" cy="24" r="5" fill="${C.stopped}"/>
      <circle cx="122" cy="24" r="5" fill="${C.metal}"/>
    `,
    states: [
      {
        key: 'running',
        label: 'Running',
        tone: 'active',
        parts: { belt: { flow: 40, stroke: C.running }, pulley: { fill: C.running, spin: 180 } },
      },
      {
        key: 'stopped',
        label: 'Stopped',
        tone: 'idle',
        parts: { belt: { flow: 0, stroke: C.dark }, pulley: { fill: C.stopped, spin: 0 } },
      },
      {
        key: 'jammed',
        label: 'Jammed',
        tone: 'fault',
        parts: {
          belt: { flow: 0, stroke: C.fault, blink: 500 },
          pulley: { fill: C.fault, spin: 0 },
        },
      },
    ],
    defaultState: 'stopped',
    stateParts: ['belt', 'pulley'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Infeed', x: 0, y: 24, side: 'left' },
      { id: 'out', label: 'Discharge', x: 140, y: 24, side: 'right' },
    ],
  },

  // ── Valves ───────────────────────────────────────────────────────────────
  {
    key: 'valve_2way',
    label: 'Valve (2-way)',
    category: 'valves',
    description:
      'The standard bow-tie gate valve. Disc colour shows open, closed or travelling.',
    icon: 'Triangle',
    width: 72,
    height: 48,
    keywords: ['valve', 'gate', 'isolation', 'two-way'],
    svg: `
      <line x1="0" y1="24" x2="14" y2="24" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="58" y1="24" x2="72" y2="24" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path data-part="disc" d="M14 8 L14 40 L58 8 L58 40 Z" fill="${C.closed}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line x1="36" y1="24" x2="36" y2="6" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <rect data-part="stem" x="28" y="0" width="16" height="6" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: valveStates('disc', {
      open: { stem: { fill: C.open } },
      closed: { stem: { fill: C.metal } },
      partial: { stem: { fill: C.partial } },
      fault: { stem: { fill: C.fault } },
    }),
    defaultState: 'closed',
    stateParts: ['disc', 'stem'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 24, side: 'left' },
      { id: 'out', label: 'Outlet', x: 72, y: 24, side: 'right' },
    ],
  },
  {
    key: 'valve_3way',
    label: 'Valve (3-way)',
    category: 'valves',
    description:
      'Diverting valve. States name the active path (A, B or mixed) rather than open/closed.',
    icon: 'GitFork',
    width: 72,
    height: 72,
    keywords: ['valve', 'three-way', 'diverting', 'mixing'],
    svg: `
      <line x1="0" y1="30" x2="14" y2="30" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="58" y1="30" x2="72" y2="30" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="36" y1="52" x2="36" y2="72" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path data-part="pathA" d="M14 14 L14 46 L36 30 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <path data-part="pathB" d="M58 14 L58 46 L36 30 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <path data-part="pathC" d="M22 52 L50 52 L36 30 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <rect data-part="actuator" x="26" y="0" width="20" height="8" rx="2" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <line x1="36" y1="8" x2="36" y2="20" stroke="${C.bodyEdge}" stroke-width="2.5"/>
    `,
    states: [
      {
        key: 'a_to_b',
        label: 'A → B (straight)',
        tone: 'active',
        parts: {
          pathA: { fill: C.open },
          pathB: { fill: C.open },
          pathC: { fill: C.closed },
          actuator: { fill: C.open },
        },
      },
      {
        key: 'a_to_c',
        label: 'A → C (diverted)',
        tone: 'active',
        parts: {
          pathA: { fill: C.open },
          pathB: { fill: C.closed },
          pathC: { fill: C.open },
          actuator: { fill: C.accent },
        },
      },
      {
        key: 'mixing',
        label: 'Mixing / travelling',
        tone: 'warning',
        parts: {
          pathA: { fill: C.partial },
          pathB: { fill: C.partial },
          pathC: { fill: C.partial },
          actuator: { fill: C.partial },
        },
      },
      {
        key: 'closed',
        label: 'All ports closed',
        tone: 'idle',
        parts: {
          pathA: { fill: C.closed },
          pathB: { fill: C.closed },
          pathC: { fill: C.closed },
          actuator: { fill: C.metal },
        },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          pathA: { fill: C.fault },
          pathB: { fill: C.fault },
          pathC: { fill: C.fault },
          actuator: { fill: C.fault, blink: 600 },
        },
      },
    ],
    defaultState: 'closed',
    stateParts: ['pathA', 'pathB', 'pathC', 'actuator'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'a', label: 'Port A', x: 0, y: 30, side: 'left' },
      { id: 'b', label: 'Port B', x: 72, y: 30, side: 'right' },
      { id: 'c', label: 'Port C', x: 36, y: 72, side: 'bottom' },
    ],
  },
  {
    key: 'valve_control',
    label: 'Control valve',
    category: 'valves',
    description:
      'Valve with a diaphragm actuator. Bind `level` to its 0–100 position to show travel as well as state.',
    icon: 'SlidersVertical',
    width: 72,
    height: 72,
    keywords: ['valve', 'control', 'modulating', 'actuator', 'cv'],
    svg: `
      <line x1="0" y1="54" x2="14" y2="54" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="58" y1="54" x2="72" y2="54" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path data-part="disc" d="M14 38 L14 70 L58 38 L58 70 Z" fill="${C.closed}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line x1="36" y1="54" x2="36" y2="22" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <path data-part="diaphragm" d="M14 22 A22 14 0 0 1 58 22 Z" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <rect x="18" y="6" width="36" height="16" rx="2" fill="none" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect data-part="travel" x="20" y="20" width="32" height="0" fill="${C.accent}"/>
    `,
    states: valveStates('disc', {
      open: { diaphragm: { fill: C.open } },
      closed: { diaphragm: { fill: C.metal } },
      partial: { diaphragm: { fill: C.partial } },
      fault: { diaphragm: { fill: C.fault, blink: 600 } },
    }),
    defaultState: 'closed',
    stateParts: ['disc', 'diaphragm', 'travel'],
    bindable: [...PROCESS_BINDABLE, 'level'],
    level: { part: 'travel', top: 8, bottom: 20 },
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 54, side: 'left' },
      { id: 'out', label: 'Outlet', x: 72, y: 54, side: 'right' },
    ],
  },
  {
    key: 'valve_check',
    label: 'Check valve',
    category: 'valves',
    description:
      'Non-return valve. The arrow turns green on forward flow and red on reverse.',
    icon: 'ArrowRightToLine',
    width: 72,
    height: 44,
    keywords: ['valve', 'check', 'non-return', 'nrv'],
    svg: `
      <line x1="0" y1="22" x2="14" y2="22" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="58" y1="22" x2="72" y2="22" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path data-part="flap" d="M14 6 L14 38 L50 22 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line data-part="seat" x1="54" y1="6" x2="54" y2="38" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Forward flow',
        tone: 'active',
        parts: { flap: { fill: C.open }, seat: { stroke: C.open } },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: { flap: { fill: C.stopped }, seat: { stroke: C.bodyEdge } },
      },
      {
        key: 'reverse',
        label: 'Reverse flow',
        tone: 'fault',
        parts: {
          flap: { fill: C.fault, blink: 500 },
          seat: { stroke: C.fault },
        },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['flap', 'seat'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 22, side: 'left' },
      { id: 'out', label: 'Outlet', x: 72, y: 22, side: 'right' },
    ],
  },
  {
    key: 'valve_relief',
    label: 'Pressure relief valve',
    category: 'valves',
    description: 'Spring-loaded PSV. Blinks while lifted.',
    icon: 'TriangleAlert',
    width: 60,
    height: 76,
    keywords: ['valve', 'relief', 'psv', 'safety'],
    svg: `
      <line x1="0" y1="62" x2="14" y2="62" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path data-part="body" d="M14 48 L14 76 L44 62 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line x1="30" y1="56" x2="30" y2="22" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <path data-part="spring" d="M22 22 L38 18 L22 14 L38 10 L22 6" fill="none" stroke="${C.bodyEdge}" stroke-width="2"/>
      <line x1="18" y1="2" x2="42" y2="2" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="44" y1="62" x2="60" y2="62" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'seated',
        label: 'Seated',
        tone: 'normal',
        parts: { body: { fill: C.stopped }, spring: { stroke: C.bodyEdge } },
      },
      {
        key: 'lifted',
        label: 'Lifted / relieving',
        tone: 'fault',
        parts: {
          body: { fill: C.fault, blink: 450 },
          spring: { stroke: C.fault },
        },
      },
      {
        key: 'approaching',
        label: 'Approaching set point',
        tone: 'warning',
        parts: { body: { fill: C.warn }, spring: { stroke: C.warn } },
      },
    ],
    defaultState: 'seated',
    stateParts: ['body', 'spring'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 62, side: 'left' },
      { id: 'vent', label: 'Vent', x: 60, y: 62, side: 'right' },
    ],
  },

  // ── Vessels ──────────────────────────────────────────────────────────────
  {
    key: 'tank_vertical',
    label: 'Tank (vertical, level)',
    category: 'vessels',
    description:
      'Vertical tank with a 0–100 fill. Bind `level` to a level transmitter and `state` to high/low switches.',
    icon: 'Container',
    width: 90,
    height: 130,
    keywords: ['tank', 'vessel', 'level', 'storage'],
    svg: `
      <rect data-part="shell" x="8" y="8" width="74" height="114" rx="6" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="3"/>
      <clipPath id="clip-tank-vertical"><rect x="11" y="11" width="68" height="108" rx="5"/></clipPath>
      <g clip-path="url(#clip-tank-vertical)">
        <rect data-part="liquid" x="11" y="119" width="68" height="0" fill="${C.liquid}" fill-opacity="0.85"/>
      </g>
      <line x1="8" y1="35" x2="82" y2="35" stroke="${C.fault}" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="8" y1="100" x2="82" y2="100" stroke="${C.warn}" stroke-width="1" stroke-dasharray="4 4"/>
      <rect x="36" y="0" width="18" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="36" y="122" width="18" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: levelStates('liquid', 'shell'),
    defaultState: 'normal',
    stateParts: ['liquid', 'shell'],
    bindable: [...PROCESS_BINDABLE, 'level'],
    level: { part: 'liquid', top: 11, bottom: 119 },
    ports: [
      { id: 'in', label: 'Fill', x: 45, y: 0, side: 'top' },
      { id: 'out', label: 'Drain', x: 45, y: 130, side: 'bottom' },
    ],
  },
  {
    key: 'tank_horizontal',
    label: 'Tank (horizontal, level)',
    category: 'vessels',
    description: 'Horizontal bullet tank with a 0–100 fill.',
    icon: 'Container',
    width: 150,
    height: 72,
    keywords: ['tank', 'horizontal', 'bullet', 'level'],
    svg: `
      <rect data-part="shell" x="18" y="10" width="114" height="52" rx="26" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="3"/>
      <clipPath id="clip-tank-horizontal"><rect x="21" y="13" width="108" height="46" rx="23"/></clipPath>
      <g clip-path="url(#clip-tank-horizontal)">
        <rect data-part="liquid" x="21" y="59" width="108" height="0" fill="${C.liquid}" fill-opacity="0.85"/>
      </g>
      <rect x="66" y="2" width="18" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="66" y="62" width="18" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: levelStates('liquid', 'shell'),
    defaultState: 'normal',
    stateParts: ['liquid', 'shell'],
    bindable: [...PROCESS_BINDABLE, 'level'],
    level: { part: 'liquid', top: 13, bottom: 59 },
    ports: [
      { id: 'in', label: 'Fill', x: 75, y: 2, side: 'top' },
      { id: 'out', label: 'Drain', x: 75, y: 70, side: 'bottom' },
    ],
  },
  {
    key: 'vessel_pressure',
    label: 'Pressure vessel',
    category: 'vessels',
    description:
      'Dished-end pressure vessel. States follow pressure rather than level.',
    icon: 'Cylinder',
    width: 96,
    height: 128,
    keywords: ['vessel', 'pressure', 'separator', 'receiver'],
    svg: `
      <path data-part="shell" d="M14 30 A34 24 0 0 1 82 30 L82 98 A34 24 0 0 1 14 98 Z" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="3"/>
      <clipPath id="clip-vessel-pressure"><path d="M17 32 A31 21 0 0 1 79 32 L79 96 A31 21 0 0 1 17 96 Z"/></clipPath>
      <g clip-path="url(#clip-vessel-pressure)">
        <rect data-part="liquid" x="17" y="115" width="62" height="0" fill="${C.liquid}" fill-opacity="0.8"/>
      </g>
      <rect x="40" y="0" width="16" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="40" y="118" width="16" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: [
      {
        key: 'normal',
        label: 'Normal pressure',
        tone: 'normal',
        parts: { shell: { stroke: C.bodyEdge }, liquid: { fill: C.liquid } },
      },
      {
        key: 'high',
        label: 'High pressure',
        tone: 'warning',
        parts: { shell: { stroke: C.warn, strokeWidth: 4 }, liquid: { fill: C.liquidLow } },
      },
      {
        key: 'trip',
        label: 'Over-pressure trip',
        tone: 'fault',
        parts: {
          shell: { stroke: C.fault, strokeWidth: 4, blink: 500 },
          liquid: { fill: C.liquidHigh },
        },
      },
      {
        key: 'depressurised',
        label: 'Depressurised',
        tone: 'idle',
        parts: { shell: { stroke: C.metal }, liquid: { opacity: 0.25 } },
      },
    ],
    defaultState: 'normal',
    stateParts: ['shell', 'liquid'],
    bindable: [...PROCESS_BINDABLE, 'level'],
    level: { part: 'liquid', top: 32, bottom: 115 },
    ports: [
      { id: 'in', label: 'Inlet', x: 48, y: 0, side: 'top' },
      { id: 'out', label: 'Outlet', x: 48, y: 128, side: 'bottom' },
    ],
  },
  {
    key: 'filter',
    label: 'Filter / strainer',
    category: 'vessels',
    description:
      'Cartridge filter. States show clean, a rising differential and a blocked element.',
    icon: 'Funnel',
    width: 72,
    height: 96,
    keywords: ['filter', 'strainer', 'cartridge', 'dp'],
    svg: `
      <rect data-part="housing" x="14" y="12" width="44" height="72" rx="5" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="element">
        <path d="M22 20 L50 20 L50 76 L22 76 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
        <line x1="26" y1="20" x2="26" y2="76" stroke="${C.metal}" stroke-width="2"/>
        <line x1="32" y1="20" x2="32" y2="76" stroke="${C.metal}" stroke-width="2"/>
        <line x1="38" y1="20" x2="38" y2="76" stroke="${C.metal}" stroke-width="2"/>
        <line x1="44" y1="20" x2="44" y2="76" stroke="${C.metal}" stroke-width="2"/>
      </g>
      <rect x="28" y="4" width="16" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <rect x="28" y="84" width="16" height="8" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: [
      {
        key: 'clean',
        label: 'Clean',
        tone: 'normal',
        parts: { housing: { stroke: C.bodyEdge }, element: { opacity: 1 } },
      },
      {
        key: 'fouling',
        label: 'Fouling (high ΔP)',
        tone: 'warning',
        parts: { housing: { stroke: C.warn, strokeWidth: 3.5 }, element: { fill: C.warn } },
      },
      {
        key: 'blocked',
        label: 'Blocked',
        tone: 'fault',
        parts: {
          housing: { stroke: C.fault, strokeWidth: 3.5, blink: 600 },
          element: { fill: C.fault },
        },
      },
      {
        key: 'bypassed',
        label: 'Bypassed',
        tone: 'idle',
        parts: { housing: { stroke: C.metal }, element: { opacity: 0.3 } },
      },
    ],
    defaultState: 'clean',
    stateParts: ['housing', 'element'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Inlet', x: 36, y: 4, side: 'top' },
      { id: 'out', label: 'Outlet', x: 36, y: 92, side: 'bottom' },
    ],
  },

  // ── Piping ───────────────────────────────────────────────────────────────
  {
    key: 'pipe_segment',
    label: 'Pipe segment',
    category: 'piping',
    description:
      'A straight run. Bind `state` to show flow — the dashes animate in the direction of travel.',
    icon: 'Minus',
    width: 120,
    height: 20,
    linear: true,
    keywords: ['pipe', 'line', 'run', 'flow'],
    svg: `
      <rect x="0" y="6" width="120" height="8" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <line data-part="flowline" x1="2" y1="10" x2="118" y2="10" stroke="${C.stopped}" stroke-width="4" stroke-dasharray="12 8"/>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Flowing',
        tone: 'active',
        parts: { flowline: { stroke: C.liquid, flow: 45 } },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: { flowline: { stroke: C.stopped, flow: 0 } },
      },
      {
        key: 'reverse',
        label: 'Reverse flow',
        tone: 'warning',
        parts: { flowline: { stroke: C.warn, flow: -45 } },
      },
      {
        key: 'leak',
        label: 'Leak detected',
        tone: 'fault',
        parts: { flowline: { stroke: C.fault, flow: 20, blink: 600 } },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['flowline'],
    bindable: ['state', 'stroke', 'visibility', 'blink'],
    ports: [
      { id: 'a', label: 'End A', x: 0, y: 10, side: 'left' },
      { id: 'b', label: 'End B', x: 120, y: 10, side: 'right' },
    ],
  },
  {
    key: 'pipe_elbow',
    label: 'Pipe elbow',
    category: 'piping',
    description: '90° bend. Rotate the element for the other three corners.',
    icon: 'CornerDownRight',
    width: 60,
    height: 60,
    linear: true,
    keywords: ['pipe', 'elbow', 'bend', '90'],
    svg: `
      <path d="M0 26 L34 26 L34 60 L26 60 L26 34 L0 34 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <path data-part="flowline" d="M2 30 L30 30 L30 58" fill="none" stroke="${C.stopped}" stroke-width="4" stroke-dasharray="12 8"/>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Flowing',
        tone: 'active',
        parts: { flowline: { stroke: C.liquid, flow: 45 } },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: { flowline: { stroke: C.stopped, flow: 0 } },
      },
      {
        key: 'leak',
        label: 'Leak detected',
        tone: 'fault',
        parts: { flowline: { stroke: C.fault, blink: 600 } },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['flowline'],
    bindable: ['state', 'stroke', 'visibility', 'blink'],
    ports: [
      { id: 'a', label: 'End A', x: 0, y: 30, side: 'left' },
      { id: 'b', label: 'End B', x: 30, y: 60, side: 'bottom' },
    ],
  },
  {
    key: 'pipe_tee',
    label: 'Pipe tee',
    category: 'piping',
    description: 'Three-way junction with an independently bindable branch.',
    icon: 'GitMerge',
    width: 80,
    height: 56,
    linear: true,
    keywords: ['pipe', 'tee', 'branch', 'junction'],
    svg: `
      <path d="M0 22 L80 22 L80 30 L44 30 L44 56 L36 56 L36 30 L0 30 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <line data-part="flowline" x1="2" y1="26" x2="78" y2="26" stroke="${C.stopped}" stroke-width="4" stroke-dasharray="12 8"/>
      <line data-part="branchline" x1="40" y1="26" x2="40" y2="54" stroke="${C.stopped}" stroke-width="4" stroke-dasharray="12 8"/>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Flowing (run + branch)',
        tone: 'active',
        parts: {
          flowline: { stroke: C.liquid, flow: 45 },
          branchline: { stroke: C.liquid, flow: 45 },
        },
      },
      {
        key: 'run_only',
        label: 'Run only',
        tone: 'normal',
        parts: {
          flowline: { stroke: C.liquid, flow: 45 },
          branchline: { stroke: C.stopped, flow: 0 },
        },
      },
      {
        key: 'branch_only',
        label: 'Branch only',
        tone: 'normal',
        parts: {
          flowline: { stroke: C.stopped, flow: 0 },
          branchline: { stroke: C.liquid, flow: 45 },
        },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: {
          flowline: { stroke: C.stopped, flow: 0 },
          branchline: { stroke: C.stopped, flow: 0 },
        },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['flowline', 'branchline'],
    bindable: ['state', 'stroke', 'visibility', 'blink'],
    ports: [
      { id: 'a', label: 'End A', x: 0, y: 26, side: 'left' },
      { id: 'b', label: 'End B', x: 80, y: 26, side: 'right' },
      { id: 'c', label: 'Branch', x: 40, y: 56, side: 'bottom' },
    ],
  },
  {
    key: 'pipe_reducer',
    label: 'Pipe reducer',
    category: 'piping',
    description: 'Concentric reducer between two line sizes.',
    icon: 'ChevronsRight',
    width: 60,
    height: 40,
    linear: true,
    keywords: ['pipe', 'reducer', 'taper'],
    svg: `
      <path data-part="body" d="M0 8 L22 8 L38 16 L60 16 L60 24 L38 24 L22 32 L0 32 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <line data-part="flowline" x1="2" y1="20" x2="58" y2="20" stroke="${C.stopped}" stroke-width="3.5" stroke-dasharray="10 7"/>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Flowing',
        tone: 'active',
        parts: { flowline: { stroke: C.liquid, flow: 45 }, body: { fill: C.shell } },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: { flowline: { stroke: C.stopped, flow: 0 }, body: { fill: C.shell } },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['flowline', 'body'],
    bindable: ['state', 'stroke', 'visibility'],
    ports: [
      { id: 'a', label: 'Large end', x: 0, y: 20, side: 'left' },
      { id: 'b', label: 'Small end', x: 60, y: 20, side: 'right' },
    ],
  },

  // ── Thermal plant ────────────────────────────────────────────────────────
  {
    key: 'heat_exchanger',
    label: 'Heat exchanger',
    category: 'thermal',
    description:
      'Shell-and-tube exchanger. The tube bundle recolours with duty.',
    icon: 'Thermometer',
    width: 130,
    height: 80,
    keywords: ['heat exchanger', 'hx', 'shell and tube', 'cooler'],
    svg: `
      <rect data-part="shell" x="10" y="16" width="110" height="48" rx="8" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <path data-part="tubes" d="M22 28 L108 28 M22 40 L108 40 M22 52 L108 52" stroke="${C.metal}" stroke-width="3" fill="none"/>
      <line x1="30" y1="4" x2="30" y2="16" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="100" y1="64" x2="100" y2="76" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="0" y1="40" x2="10" y2="40" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="120" y1="40" x2="130" y2="40" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'in_service',
        label: 'In service',
        tone: 'active',
        parts: { shell: { stroke: C.running }, tubes: { stroke: C.warn } },
      },
      {
        key: 'standby',
        label: 'Standby',
        tone: 'idle',
        parts: { shell: { stroke: C.bodyEdge }, tubes: { stroke: C.metal } },
      },
      {
        key: 'fouled',
        label: 'Fouled',
        tone: 'warning',
        parts: { shell: { stroke: C.warn }, tubes: { stroke: C.warn, opacity: 0.6 } },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          shell: { stroke: C.fault, blink: 600 },
          tubes: { stroke: C.fault },
        },
      },
    ],
    defaultState: 'standby',
    stateParts: ['shell', 'tubes'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'shell_in', label: 'Shell in', x: 0, y: 40, side: 'left' },
      { id: 'shell_out', label: 'Shell out', x: 130, y: 40, side: 'right' },
      { id: 'tube_in', label: 'Tube in', x: 30, y: 4, side: 'top' },
      { id: 'tube_out', label: 'Tube out', x: 100, y: 76, side: 'bottom' },
    ],
  },
  {
    key: 'boiler',
    label: 'Boiler',
    category: 'thermal',
    description: 'Fired boiler. The flame appears and flickers when firing.',
    icon: 'Flame',
    width: 100,
    height: 110,
    keywords: ['boiler', 'burner', 'steam', 'fired'],
    svg: `
      <rect data-part="shell" x="12" y="10" width="76" height="76" rx="8" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="3"/>
      <path d="M24 86 L76 86 L70 100 L30 100 Z" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <path data-part="flame" d="M50 80 C42 72 44 64 50 56 C56 64 58 72 50 80 Z" fill="${C.warn}" opacity="0"/>
      <rect x="42" y="0" width="16" height="10" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <line x1="0" y1="48" x2="12" y2="48" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="88" y1="30" x2="100" y2="30" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'firing',
        label: 'Firing',
        tone: 'active',
        parts: {
          shell: { stroke: C.running },
          flame: { opacity: 1, fill: C.warn, blink: 260 },
        },
      },
      {
        key: 'standby',
        label: 'Standby',
        tone: 'idle',
        parts: { shell: { stroke: C.bodyEdge }, flame: { opacity: 0 } },
      },
      {
        key: 'lockout',
        label: 'Burner lockout',
        tone: 'fault',
        parts: {
          shell: { stroke: C.fault, blink: 500 },
          flame: { opacity: 1, fill: C.fault, blink: 500 },
        },
      },
    ],
    defaultState: 'standby',
    stateParts: ['shell', 'flame'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'feed', label: 'Feedwater', x: 0, y: 48, side: 'left' },
      { id: 'steam', label: 'Steam', x: 100, y: 30, side: 'right' },
      { id: 'stack', label: 'Stack', x: 50, y: 0, side: 'top' },
    ],
  },
  {
    key: 'chiller',
    label: 'Chiller',
    category: 'thermal',
    description:
      'Packaged chiller. The cold-coil marker turns blue on the compressors running.',
    icon: 'Snowflake',
    width: 120,
    height: 86,
    keywords: ['chiller', 'cooling', 'hvac', 'refrigeration'],
    svg: `
      <rect data-part="cabinet" x="8" y="10" width="104" height="66" rx="6" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="coil">
        <path d="M22 26 L98 26 M22 38 L98 38 M22 50 L98 50 M22 62 L98 62" stroke="${C.metal}" stroke-width="3" fill="none"/>
      </g>
      <g data-part="flake">
        <line x1="60" y1="32" x2="60" y2="56" stroke="${C.liquid}" stroke-width="2.5"/>
        <line x1="49" y1="38" x2="71" y2="50" stroke="${C.liquid}" stroke-width="2.5"/>
        <line x1="49" y1="50" x2="71" y2="38" stroke="${C.liquid}" stroke-width="2.5"/>
      </g>
      <line x1="0" y1="30" x2="8" y2="30" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="0" y1="58" x2="8" y2="58" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'cooling',
        label: 'Cooling',
        tone: 'active',
        parts: {
          cabinet: { stroke: C.running },
          coil: { stroke: C.liquid },
          flake: { opacity: 1, spin: 60 },
        },
      },
      {
        key: 'off',
        label: 'Off',
        tone: 'idle',
        parts: {
          cabinet: { stroke: C.bodyEdge },
          coil: { stroke: C.metal },
          flake: { opacity: 0.25, spin: 0 },
        },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: {
          cabinet: { stroke: C.fault, blink: 550 },
          coil: { stroke: C.fault },
          flake: { opacity: 0.4, spin: 0 },
        },
      },
    ],
    defaultState: 'off',
    stateParts: ['cabinet', 'coil', 'flake'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'chw_supply', label: 'CHW supply', x: 0, y: 30, side: 'left' },
      { id: 'chw_return', label: 'CHW return', x: 0, y: 58, side: 'left' },
    ],
  },
  {
    key: 'cooling_tower',
    label: 'Cooling tower',
    category: 'thermal',
    description: 'Induced-draught tower; the fan spins while in service.',
    icon: 'CloudFog',
    width: 110,
    height: 104,
    keywords: ['cooling tower', 'ct', 'condenser water'],
    svg: `
      <path data-part="shell" d="M18 28 L92 28 L80 96 L30 96 Z" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <rect x="22" y="18" width="66" height="10" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <g data-part="fan">
        <line x1="55" y1="4" x2="55" y2="18" stroke="${C.bodyEdge}" stroke-width="2"/>
        <path d="M55 11 L33 5 L33 17 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="1.2"/>
        <path d="M55 11 L77 5 L77 17 Z" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="1.2"/>
      </g>
      <path data-part="fill" d="M28 54 L82 54 M30 66 L80 66 M32 78 L78 78" stroke="${C.liquid}" stroke-width="2.5" fill="none" stroke-dasharray="8 6"/>
    `,
    states: [
      {
        key: 'in_service',
        label: 'In service',
        tone: 'active',
        parts: {
          shell: { stroke: C.running },
          fan: { fill: C.running, spin: 240 },
          fill: { stroke: C.liquid, flow: 20 },
        },
      },
      {
        key: 'off',
        label: 'Off',
        tone: 'idle',
        parts: {
          shell: { stroke: C.bodyEdge },
          fan: { fill: C.stopped, spin: 0 },
          fill: { stroke: C.stopped, flow: 0 },
        },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          shell: { stroke: C.fault, blink: 600 },
          fan: { fill: C.fault, spin: 0 },
          fill: { stroke: C.fault, flow: 0 },
        },
      },
    ],
    defaultState: 'off',
    stateParts: ['shell', 'fan', 'fill'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Hot water in', x: 110, y: 50, side: 'right' },
      { id: 'out', label: 'Cold water out', x: 0, y: 90, side: 'left' },
    ],
  },

  // ── Electrical ───────────────────────────────────────────────────────────
  {
    key: 'generator',
    label: 'Generator',
    category: 'electrical',
    description: 'Generator set. The rotor marker turns while on load.',
    icon: 'Zap',
    width: 80,
    height: 80,
    keywords: ['generator', 'genset', 'G', 'alternator'],
    svg: `
      <circle data-part="frame" cx="40" cy="40" r="30" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="3"/>
      <text x="40" y="48" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="700" fill="${C.bodyEdge}">G</text>
      <g data-part="rotor"><path d="M40 10 A30 30 0 0 1 62 22" fill="none" stroke="${C.stopped}" stroke-width="4"/></g>
      <line x1="40" y1="70" x2="40" y2="80" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'online',
        label: 'On load',
        tone: 'active',
        parts: { frame: { stroke: C.running }, rotor: { stroke: C.running, spin: 200 } },
      },
      {
        key: 'standby',
        label: 'Standby',
        tone: 'idle',
        parts: { frame: { stroke: C.bodyEdge }, rotor: { stroke: C.stopped, spin: 0 } },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          frame: { stroke: C.fault, blink: 550 },
          rotor: { stroke: C.fault, spin: 0 },
        },
      },
    ],
    defaultState: 'standby',
    stateParts: ['frame', 'rotor'],
    bindable: PROCESS_BINDABLE,
    ports: [{ id: 'out', label: 'Outgoing', x: 40, y: 80, side: 'bottom' }],
  },
  {
    key: 'circuit_breaker',
    label: 'Circuit breaker',
    category: 'electrical',
    description:
      'Draw-out breaker. The contact bar swings open when the breaker is open and blinks on a trip.',
    icon: 'ToggleLeft',
    width: 60,
    height: 80,
    keywords: ['breaker', 'cb', 'acb', 'switchgear'],
    svg: `
      <line x1="30" y1="0" x2="30" y2="20" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="30" y1="60" x2="30" y2="80" stroke="${C.bodyEdge}" stroke-width="3"/>
      <circle cx="30" cy="20" r="4" fill="${C.bodyEdge}"/>
      <circle cx="30" cy="60" r="4" fill="${C.bodyEdge}"/>
      <line data-part="contact" x1="30" y1="20" x2="30" y2="60" stroke="${C.running}" stroke-width="4"/>
      <rect data-part="box" x="10" y="14" width="40" height="52" rx="3" fill="none" stroke="${C.bodyEdge}" stroke-width="1.5" stroke-dasharray="4 3"/>
    `,
    states: [
      {
        key: 'closed',
        label: 'Closed',
        tone: 'active',
        parts: { contact: { stroke: C.running }, box: { stroke: C.running } },
      },
      {
        key: 'open',
        label: 'Open',
        tone: 'idle',
        parts: {
          contact: { stroke: C.stopped, rotation: 28, opacity: 0.5 },
          box: { stroke: C.bodyEdge },
        },
      },
      {
        key: 'tripped',
        label: 'Tripped',
        tone: 'fault',
        parts: {
          contact: { stroke: C.fault, blink: 450 },
          box: { stroke: C.fault },
        },
      },
    ],
    defaultState: 'open',
    stateParts: ['contact', 'box'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'in', label: 'Incoming', x: 30, y: 0, side: 'top' },
      { id: 'out', label: 'Outgoing', x: 30, y: 80, side: 'bottom' },
    ],
  },
  {
    key: 'transformer',
    label: 'Transformer',
    category: 'electrical',
    description: 'Two-winding transformer drawn as the usual twin circles.',
    icon: 'CircleDotDashed',
    width: 72,
    height: 96,
    keywords: ['transformer', 'tx', 'winding'],
    svg: `
      <circle data-part="primary" cx="36" cy="34" r="22" fill="none" stroke="${C.bodyEdge}" stroke-width="3"/>
      <circle data-part="secondary" cx="36" cy="62" r="22" fill="none" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="36" y1="0" x2="36" y2="12" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="36" y1="84" x2="36" y2="96" stroke="${C.bodyEdge}" stroke-width="3"/>
    `,
    states: [
      {
        key: 'energised',
        label: 'Energised',
        tone: 'active',
        parts: {
          primary: { stroke: C.running },
          secondary: { stroke: C.running },
        },
      },
      {
        key: 'deenergised',
        label: 'De-energised',
        tone: 'idle',
        parts: {
          primary: { stroke: C.bodyEdge },
          secondary: { stroke: C.bodyEdge },
        },
      },
      {
        key: 'overtemp',
        label: 'Winding over-temperature',
        tone: 'warning',
        parts: { primary: { stroke: C.warn }, secondary: { stroke: C.warn } },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          primary: { stroke: C.fault, blink: 500 },
          secondary: { stroke: C.fault, blink: 500 },
        },
      },
    ],
    defaultState: 'deenergised',
    stateParts: ['primary', 'secondary'],
    bindable: PROCESS_BINDABLE,
    ports: [
      { id: 'hv', label: 'HV', x: 36, y: 0, side: 'top' },
      { id: 'lv', label: 'LV', x: 36, y: 96, side: 'bottom' },
    ],
  },
  {
    key: 'busbar',
    label: 'Busbar',
    category: 'electrical',
    description:
      'A section of bus. Bind `state` to the section’s live status; connections tap off anywhere along it.',
    icon: 'Minus',
    width: 180,
    height: 24,
    linear: true,
    keywords: ['busbar', 'bus', 'section', 'switchboard'],
    svg: `
      <rect data-part="bar" x="0" y="8" width="180" height="8" rx="2" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
    `,
    states: powerStates('bar'),
    defaultState: 'deenergised',
    stateParts: ['bar'],
    bindable: ['state', 'fill', 'visibility', 'blink'],
    ports: [
      { id: 'a', label: 'End A', x: 0, y: 12, side: 'left' },
      { id: 'mid', label: 'Tap', x: 90, y: 24, side: 'bottom' },
      { id: 'b', label: 'End B', x: 180, y: 12, side: 'right' },
    ],
  },

  // ── Instruments ──────────────────────────────────────────────────────────
  {
    key: 'sensor_transmitter',
    label: 'Sensor / transmitter',
    category: 'instruments',
    description:
      'The ISA instrument bubble. Bind `text` to the tag or the reading and `state` to its health.',
    icon: 'CircleDot',
    width: 64,
    height: 64,
    keywords: ['sensor', 'transmitter', 'instrument', 'tag', 'isa'],
    svg: `
      <circle data-part="bubble" cx="32" cy="32" r="24" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <line x1="8" y1="32" x2="56" y2="32" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <text data-part="tag" x="32" y="26" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="${C.text}">TT</text>
      <text data-part="value" x="32" y="46" text-anchor="middle" font-family="sans-serif" font-size="11" fill="${C.text}">--</text>
      <line x1="32" y1="56" x2="32" y2="64" stroke="${C.bodyEdge}" stroke-width="2"/>
    `,
    states: [
      {
        key: 'good',
        label: 'Good',
        tone: 'normal',
        parts: { bubble: { stroke: C.bodyEdge }, value: { fill: C.text } },
      },
      {
        key: 'high',
        label: 'High',
        tone: 'warning',
        parts: { bubble: { stroke: C.warn, strokeWidth: 3.5 }, value: { fill: C.warn } },
      },
      {
        key: 'low',
        label: 'Low',
        tone: 'warning',
        parts: { bubble: { stroke: C.warn, strokeWidth: 3.5 }, value: { fill: C.warn } },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: {
          bubble: { stroke: C.fault, strokeWidth: 4, blink: 600 },
          value: { fill: C.fault },
        },
      },
      {
        key: 'stale',
        label: 'No data / stale',
        tone: 'idle',
        parts: { bubble: { stroke: C.metal, opacity: 0.6 }, value: { fill: C.metal } },
      },
    ],
    defaultState: 'stale',
    stateParts: ['bubble', 'tag', 'value'],
    bindable: INSTRUMENT_BINDABLE,
    textPart: 'value',
    ports: [{ id: 'process', label: 'Process', x: 32, y: 64, side: 'bottom' }],
  },
  {
    key: 'gauge',
    label: 'Gauge',
    category: 'instruments',
    description:
      'Dial gauge. Bind `level` to the measurement and the needle sweeps 0–100 across 240°.',
    icon: 'Gauge',
    width: 80,
    height: 80,
    keywords: ['gauge', 'dial', 'pressure', 'indicator'],
    svg: `
      <circle data-part="face" cx="40" cy="40" r="32" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <path d="M17 60 A32 32 0 1 1 63 60" fill="none" stroke="${C.metal}" stroke-width="4"/>
      <path data-part="band" d="M52 16 A32 32 0 0 1 63 60" fill="none" stroke="${C.fault}" stroke-width="4" opacity="0.6"/>
      <g data-part="needle"><line x1="40" y1="40" x2="40" y2="14" stroke="${C.dark}" stroke-width="3"/></g>
      <circle cx="40" cy="40" r="4" fill="${C.dark}"/>
      <text data-part="value" x="40" y="66" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="${C.text}">--</text>
    `,
    states: [
      {
        key: 'normal',
        label: 'Normal',
        tone: 'normal',
        parts: { face: { stroke: C.bodyEdge }, needle: { stroke: C.dark } },
      },
      {
        key: 'high',
        label: 'High',
        tone: 'warning',
        parts: { face: { stroke: C.warn, strokeWidth: 3.5 }, needle: { stroke: C.warn } },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: {
          face: { stroke: C.fault, strokeWidth: 4, blink: 600 },
          needle: { stroke: C.fault },
        },
      },
      {
        key: 'stale',
        label: 'No data',
        tone: 'idle',
        parts: { face: { stroke: C.metal, opacity: 0.6 }, needle: { opacity: 0.3 } },
      },
    ],
    defaultState: 'stale',
    stateParts: ['face', 'needle', 'band', 'value'],
    bindable: [...INSTRUMENT_BINDABLE, 'level', 'rotation'],
    /**
     * The needle points; it does not fill. A `level` binding here sweeps it
     * through the dial's 240° arc rather than resizing a rect — the editor
     * still shows a plain 0–100 form.
     */
    levelSweep: { part: 'needle', fromDeg: -120, toDeg: 120 },
    textPart: 'value',
    ports: [{ id: 'process', label: 'Process', x: 40, y: 80, side: 'bottom' }],
  },
  {
    key: 'flow_meter',
    label: 'Flow meter',
    category: 'instruments',
    description:
      'In-line flow element with a reading. Bind `text` to the rate and `state` to flow/no-flow.',
    icon: 'Waves',
    width: 90,
    height: 56,
    keywords: ['flow', 'meter', 'fit', 'magmeter'],
    svg: `
      <line x1="0" y1="28" x2="18" y2="28" stroke="${C.bodyEdge}" stroke-width="3"/>
      <line x1="72" y1="28" x2="90" y2="28" stroke="${C.bodyEdge}" stroke-width="3"/>
      <rect data-part="body" x="18" y="12" width="54" height="32" rx="4" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <path data-part="wave" d="M24 28 q7 -8 14 0 t14 0 t14 0" fill="none" stroke="${C.stopped}" stroke-width="3"/>
      <text data-part="value" x="45" y="54" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="${C.text}">--</text>
    `,
    states: [
      {
        key: 'flowing',
        label: 'Flowing',
        tone: 'active',
        parts: { body: { stroke: C.running }, wave: { stroke: C.liquid, flow: 30 } },
      },
      {
        key: 'noflow',
        label: 'No flow',
        tone: 'idle',
        parts: { body: { stroke: C.bodyEdge }, wave: { stroke: C.stopped, flow: 0 } },
      },
      {
        key: 'lowflow',
        label: 'Low flow',
        tone: 'warning',
        parts: { body: { stroke: C.warn }, wave: { stroke: C.warn, flow: 10 } },
      },
      {
        key: 'fault',
        label: 'Fault',
        tone: 'fault',
        parts: {
          body: { stroke: C.fault, blink: 600 },
          wave: { stroke: C.fault, flow: 0 },
        },
      },
    ],
    defaultState: 'noflow',
    stateParts: ['body', 'wave', 'value'],
    bindable: INSTRUMENT_BINDABLE,
    textPart: 'value',
    ports: [
      { id: 'in', label: 'Inlet', x: 0, y: 28, side: 'left' },
      { id: 'out', label: 'Outlet', x: 90, y: 28, side: 'right' },
    ],
  },
  {
    key: 'level_switch',
    label: 'Level switch',
    category: 'instruments',
    description: 'Discrete float or capacitance switch — made or not made.',
    icon: 'ToggleRight',
    width: 56,
    height: 72,
    keywords: ['level switch', 'float', 'ls', 'high level'],
    svg: `
      <circle data-part="bubble" cx="28" cy="20" r="17" fill="#ffffff" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <text x="28" y="25" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" fill="${C.text}">LS</text>
      <line x1="28" y1="37" x2="28" y2="54" stroke="${C.bodyEdge}" stroke-width="2"/>
      <ellipse data-part="float" cx="28" cy="62" rx="14" ry="9" fill="${C.stopped}" stroke="${C.bodyEdge}" stroke-width="2"/>
    `,
    states: [
      {
        key: 'made',
        label: 'Made',
        tone: 'active',
        parts: { float: { fill: C.running }, bubble: { stroke: C.running } },
      },
      {
        key: 'clear',
        label: 'Clear',
        tone: 'idle',
        parts: { float: { fill: C.stopped }, bubble: { stroke: C.bodyEdge } },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: {
          float: { fill: C.fault, blink: 500 },
          bubble: { stroke: C.fault },
        },
      },
    ],
    defaultState: 'clear',
    stateParts: ['bubble', 'float'],
    bindable: INSTRUMENT_BINDABLE,
    ports: [{ id: 'process', label: 'Process', x: 28, y: 72, side: 'bottom' }],
  },
  {
    key: 'digital_display',
    label: 'Digital readout',
    category: 'instruments',
    description:
      'A bare numeric field with a caption. The simplest `text` binding target.',
    icon: 'Monitor',
    width: 110,
    height: 56,
    keywords: ['display', 'readout', 'value', 'numeric'],
    svg: `
      <rect data-part="panel" x="0" y="0" width="110" height="56" rx="5" fill="${C.dark}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <text data-part="caption" x="55" y="17" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#94a3b8">VALUE</text>
      <text data-part="value" x="55" y="43" text-anchor="middle" font-family="monospace" font-size="20" font-weight="700" fill="${C.running}">--</text>
    `,
    states: [
      {
        key: 'normal',
        label: 'Normal',
        tone: 'normal',
        parts: { value: { fill: C.running }, panel: { stroke: C.bodyEdge } },
      },
      {
        key: 'warning',
        label: 'Warning',
        tone: 'warning',
        parts: { value: { fill: C.warn }, panel: { stroke: C.warn } },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: {
          value: { fill: C.fault, blink: 500 },
          panel: { stroke: C.fault },
        },
      },
      {
        key: 'stale',
        label: 'No data',
        tone: 'idle',
        parts: { value: { fill: C.metal }, panel: { stroke: C.metal } },
      },
    ],
    defaultState: 'stale',
    stateParts: ['panel', 'value', 'caption'],
    bindable: INSTRUMENT_BINDABLE,
    textPart: 'value',
    ports: [],
  },

  // ── HMI controls ─────────────────────────────────────────────────────────
  {
    key: 'indicator_lamp',
    label: 'Indicator lamp',
    category: 'hmi',
    description:
      'Pilot light. The classic blink-on-alarm target — nothing else on the diagram reads faster.',
    icon: 'Lightbulb',
    width: 44,
    height: 44,
    keywords: ['lamp', 'light', 'pilot', 'led', 'indicator'],
    svg: `
      <circle cx="22" cy="22" r="20" fill="none" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <circle data-part="lens" cx="22" cy="22" r="14" fill="${C.lampOff}"/>
      <circle cx="17" cy="17" r="4" fill="#ffffff" fill-opacity="0.35"/>
    `,
    states: [
      { key: 'off', label: 'Off', tone: 'idle', parts: { lens: { fill: C.lampOff } } },
      { key: 'on', label: 'On', tone: 'active', parts: { lens: { fill: C.running } } },
      {
        key: 'warning',
        label: 'Warning',
        tone: 'warning',
        parts: { lens: { fill: C.warn, blink: 900 } },
      },
      {
        key: 'alarm',
        label: 'Alarm',
        tone: 'fault',
        parts: { lens: { fill: C.fault, blink: 450 } },
      },
    ],
    defaultState: 'off',
    stateParts: ['lens'],
    bindable: ['state', 'fill', 'visibility', 'blink'],
    ports: [],
  },
  {
    key: 'push_button',
    label: 'Push button',
    category: 'hmi',
    description:
      'Momentary button. Give it an `action` binding and clicking it sends a command to the device.',
    icon: 'MousePointerClick',
    width: 72,
    height: 50,
    keywords: ['button', 'push button', 'command', 'start', 'stop'],
    svg: `
      <rect data-part="bezel" x="2" y="2" width="68" height="46" rx="8" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2"/>
      <rect data-part="cap" x="9" y="9" width="54" height="32" rx="6" fill="${C.metal}" stroke="${C.bodyEdge}" stroke-width="1.5"/>
      <text data-part="label" x="36" y="30" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#ffffff">START</text>
    `,
    states: [
      {
        key: 'enabled',
        label: 'Enabled',
        tone: 'normal',
        parts: { cap: { fill: C.accent }, bezel: { stroke: C.bodyEdge } },
      },
      {
        key: 'pressed',
        label: 'Pressed',
        tone: 'active',
        parts: { cap: { fill: C.running }, bezel: { stroke: C.running } },
      },
      {
        key: 'disabled',
        label: 'Disabled / interlocked',
        tone: 'idle',
        parts: { cap: { fill: C.metal, opacity: 0.5 }, bezel: { stroke: C.metal } },
      },
      {
        key: 'fault',
        label: 'Command failed',
        tone: 'fault',
        parts: {
          cap: { fill: C.fault, blink: 450 },
          bezel: { stroke: C.fault },
        },
      },
    ],
    defaultState: 'enabled',
    stateParts: ['cap', 'bezel', 'label'],
    bindable: ['state', 'fill', 'text', 'visibility', 'action'],
    textPart: 'label',
    ports: [],
  },
  {
    key: 'selector_switch',
    label: 'Selector switch',
    category: 'hmi',
    description:
      'Three-position selector (e.g. Hand / Off / Auto). The knob points at the selected position.',
    icon: 'RotateCw',
    width: 72,
    height: 72,
    keywords: ['selector', 'switch', 'hoa', 'hand off auto', 'mode'],
    svg: `
      <circle data-part="face" cx="36" cy="40" r="26" fill="${C.shell}" stroke="${C.bodyEdge}" stroke-width="2.5"/>
      <g data-part="knob"><line x1="36" y1="40" x2="36" y2="18" stroke="${C.dark}" stroke-width="5" stroke-linecap="round"/></g>
      <circle cx="36" cy="40" r="5" fill="${C.dark}"/>
      <text data-part="label" x="36" y="71" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" fill="${C.text}">OFF</text>
    `,
    states: [
      {
        key: 'hand',
        label: 'Hand / manual',
        tone: 'warning',
        parts: { knob: { stroke: C.warn, rotation: -45 }, face: { stroke: C.warn } },
      },
      {
        key: 'off',
        label: 'Off',
        tone: 'idle',
        parts: { knob: { stroke: C.dark, rotation: 0 }, face: { stroke: C.bodyEdge } },
      },
      {
        key: 'auto',
        label: 'Auto',
        tone: 'active',
        parts: { knob: { stroke: C.running, rotation: 45 }, face: { stroke: C.running } },
      },
    ],
    defaultState: 'off',
    stateParts: ['face', 'knob', 'label'],
    bindable: ['state', 'fill', 'rotation', 'text', 'visibility', 'action'],
    textPart: 'label',
    ports: [],
  },
];

/** key → manifest, which is how everything downstream looks a symbol up. */
export const SCADA_SYMBOL_CATALOGUE: Record<string, ScadaSymbolManifest> =
  Object.freeze(
    SYMBOLS.reduce<Record<string, ScadaSymbolManifest>>((acc, symbol) => {
      acc[symbol.key] = symbol;
      return acc;
    }, {}),
  );

export const SCADA_SYMBOL_KEYS = SYMBOLS.map((s) => s.key);

// ═══════════════════════════════════════════════════════════════════════════
// TRANSFORM DECLARATIONS FOR THE EDITOR
//
// The binding form is server-driven for the same reason the rule-node config
// form is: `transform` is free jsonb, and a frontend-authored form that writes
// `thresholds` where the evaluator reads `bands` produces a binding that saves
// cleanly and then resolves to the fallback state forever.
// ═══════════════════════════════════════════════════════════════════════════

export interface ScadaTransformFieldDescriptor {
  key: keyof ScadaTransform | string;
  label: string;
  type: 'number' | 'text' | 'bands' | 'map' | 'boolean';
  required?: boolean;
  help?: string;
}

export interface ScadaTransformDescriptor {
  kind: ScadaTransformKind;
  label: string;
  description: string;
  /** Which bindable properties this transform makes sense for. */
  appliesTo: ScadaBindableProperty[];
  fields: ScadaTransformFieldDescriptor[];
}

export const SCADA_TRANSFORMS: ScadaTransformDescriptor[] = [
  {
    kind: 'passthrough',
    label: 'Use the value as-is',
    description:
      'The raw value becomes the state key, colour or text. Use it when the device already reports the state name.',
    appliesTo: ['state', 'fill', 'stroke', 'text', 'rotation', 'level'],
    fields: [],
  },
  {
    kind: 'threshold',
    label: 'Numeric thresholds',
    description:
      'Bands evaluated in order; the first whose test passes wins. Anything left over falls to the fallback.',
    appliesTo: ['state', 'fill', 'stroke', 'text', 'blink'],
    fields: [
      {
        key: 'bands',
        label: 'Bands',
        type: 'bands',
        required: true,
        help: 'Order matters — put the tightest band first.',
      },
      { key: 'fallback', label: 'Otherwise', type: 'text', required: true },
    ],
  },
  {
    kind: 'valueMap',
    label: 'Value map (discrete)',
    description:
      'Exact lookup for enumerated values: 0 → closed, 1 → open, "RUN" → running.',
    appliesTo: ['state', 'fill', 'stroke', 'text', 'blink'],
    fields: [
      { key: 'map', label: 'Value → output', type: 'map', required: true },
      { key: 'fallback', label: 'Unmapped value', type: 'text', required: true },
    ],
  },
  {
    kind: 'linear',
    label: 'Rescale (linear)',
    description:
      'Map an engineering range onto the property’s own range — 0–16 bar onto a 0–100 gauge sweep, for instance.',
    appliesTo: ['level', 'rotation'],
    fields: [
      { key: 'inMin', label: 'Value at minimum', type: 'number', required: true },
      { key: 'inMax', label: 'Value at maximum', type: 'number', required: true },
      { key: 'outMin', label: 'Property minimum', type: 'number', required: true },
      { key: 'outMax', label: 'Property maximum', type: 'number', required: true },
      { key: 'clamp', label: 'Clamp out-of-range values', type: 'boolean' },
    ],
  },
  {
    kind: 'boolean',
    label: 'True / false',
    description: 'Two outputs from a truthy test. The shortest binding there is.',
    appliesTo: ['state', 'fill', 'stroke', 'text', 'visibility', 'blink'],
    fields: [
      { key: 'whenTrue', label: 'When true', type: 'text', required: true },
      { key: 'whenFalse', label: 'When false', type: 'text', required: true },
    ],
  },
  {
    kind: 'format',
    label: 'Format as text',
    description: 'Round, add a unit, add a prefix. For `text` bindings.',
    appliesTo: ['text'],
    fields: [
      { key: 'decimals', label: 'Decimal places', type: 'number' },
      { key: 'unit', label: 'Unit suffix', type: 'text' },
      { key: 'prefix', label: 'Prefix', type: 'text' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// EVALUATION
//
// The same resolution the frontend runtime performs, kept here as the
// authority. The server needs it for `POST /scada/diagrams/:id/evaluate`
// (preview a binding against a value without a device), and having one written
// implementation means the frontend's copy can be diffed against it rather
// than invented.
// ═══════════════════════════════════════════════════════════════════════════

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
};

const bandMatches = (band: ScadaThresholdBand, value: number): boolean => {
  switch (band.operator) {
    case 'lt':
      return value < band.value;
    case 'lte':
      return value <= band.value;
    case 'gt':
      return value > band.value;
    case 'gte':
      return value >= band.value;
    case 'eq':
      return value === band.value;
    case 'neq':
      return value !== band.value;
    case 'between':
      return value >= band.value && value <= (band.value2 ?? band.value);
    default:
      return false;
  }
};

/**
 * Apply a transform to a raw value.
 *
 * Returns `null` when the value cannot produce a result — an unmapped discrete
 * value with no fallback, or a non-numeric reading on a numeric transform. The
 * renderer treats `null` as "leave the element in its default state", which is
 * deliberately different from resolving to a state that says everything is
 * fine. A dead transmitter must not show a healthy pump.
 */
export const applyScadaTransform = (
  transform: ScadaTransform | null | undefined,
  value: unknown,
): string | number | null => {
  if (value === undefined || value === null) return null;
  const kind = transform?.kind ?? 'passthrough';

  switch (kind) {
    case 'passthrough':
      return typeof value === 'number' ? value : String(value);

    case 'threshold': {
      const numeric = asNumber(value);
      if (numeric === null) return transform?.fallback ?? null;
      for (const band of transform?.bands ?? []) {
        if (bandMatches(band, numeric)) return band.output;
      }
      return transform?.fallback ?? null;
    }

    case 'valueMap': {
      const key = typeof value === 'boolean' ? String(value) : String(value);
      const mapped = transform?.map?.[key];
      return mapped ?? transform?.fallback ?? null;
    }

    case 'linear': {
      const numeric = asNumber(value);
      if (numeric === null) return null;
      const inMin = transform?.inMin ?? 0;
      const inMax = transform?.inMax ?? 100;
      const outMin = transform?.outMin ?? 0;
      const outMax = transform?.outMax ?? 100;
      // A zero-width input range would divide by zero; the honest answer is
      // the bottom of the output range rather than Infinity or NaN.
      if (inMax === inMin) return outMin;
      const ratio = (numeric - inMin) / (inMax - inMin);
      const out = outMin + ratio * (outMax - outMin);
      if (transform?.clamp === false) return out;
      const lo = Math.min(outMin, outMax);
      const hi = Math.max(outMin, outMax);
      return Math.min(hi, Math.max(lo, out));
    }

    case 'boolean': {
      // '0', 'false', 'off' and '' are all falsy in process data, which plain
      // JS truthiness gets wrong for the string '0' and the string 'false'.
      const truthy =
        typeof value === 'string'
          ? !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
          : Boolean(value);
      return (truthy ? transform?.whenTrue : transform?.whenFalse) ?? null;
    }

    case 'format': {
      const numeric = asNumber(value);
      const body =
        numeric !== null && transform?.decimals !== undefined
          ? numeric.toFixed(transform.decimals)
          : String(value);
      return `${transform?.prefix ?? ''}${body}${transform?.unit ? ` ${transform.unit}` : ''}`;
    }

    default:
      return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check a binding against the symbol it is attached to.
 *
 * Returns human-readable problems, which the controller turns into a 400. The
 * point is to refuse at save time the three mistakes that are invisible
 * afterwards: a property the symbol does not expose, a transform output that
 * is not one of the symbol's state keys, and a `level` binding on a symbol
 * that has no level band to fill.
 */
export const validateScadaBinding = (
  symbolKey: string,
  binding: {
    property?: string;
    source?: string;
    deviceId?: string | null;
    key?: string | null;
    transform?: ScadaTransform | null;
  },
): string[] => {
  const problems: string[] = [];
  const symbol = SCADA_SYMBOL_CATALOGUE[symbolKey];

  if (!symbol) {
    return [`Unknown symbol "${symbolKey}"`];
  }

  const property = binding.property as ScadaBindableProperty;
  if (!property || !SCADA_BINDABLE_PROPERTIES.includes(property)) {
    problems.push(`"${binding.property}" is not a bindable property`);
    return problems;
  }

  if (!symbol.bindable.includes(property)) {
    problems.push(
      `${symbol.label} does not expose "${property}" (it exposes ${symbol.bindable.join(', ')})`,
    );
  }

  if (property === 'level' && !symbol.level && !symbol.levelSweep) {
    problems.push(
      `${symbol.label} has neither a level band nor a needle sweep, so a "level" binding has nothing to drive`,
    );
  }

  // A `text` binding needs no text part: it falls back to the element's own
  // label. Only the symbol refusing `text` outright is a problem, and that is
  // caught by the `bindable` check above.

  const source = binding.source as ScadaBindingSource;
  if (!source || !SCADA_BINDING_SOURCES.includes(source)) {
    problems.push(`"${binding.source}" is not a valid binding source`);
  }

  // A telemetry or attribute binding without a device and key can never
  // resolve. An alarm binding needs the device but not a key (the key is
  // optional there and narrows to one alarm type). A static binding needs
  // neither.
  if (source === 'telemetry' || source === 'attribute') {
    if (!binding.deviceId) problems.push(`A ${source} binding needs a device`);
    if (!binding.key) problems.push(`A ${source} binding needs a key`);
  }
  if (source === 'alarm' && !binding.deviceId) {
    problems.push('An alarm binding needs a device');
  }

  // State outputs must name a real state, or the element never changes.
  if (property === 'state') {
    const stateKeys = new Set(symbol.states.map((s) => s.key));
    const outputs: string[] = [];
    const transform = binding.transform;

    if (transform?.kind === 'threshold') {
      outputs.push(...(transform.bands ?? []).map((b) => b.output));
      if (transform.fallback) outputs.push(transform.fallback);
    } else if (transform?.kind === 'valueMap') {
      outputs.push(...Object.values(transform.map ?? {}));
      if (transform.fallback) outputs.push(transform.fallback);
    } else if (transform?.kind === 'boolean') {
      if (transform.whenTrue) outputs.push(transform.whenTrue);
      if (transform.whenFalse) outputs.push(transform.whenFalse);
    }

    for (const output of outputs) {
      if (!stateKeys.has(output)) {
        problems.push(
          `"${output}" is not a state of ${symbol.label} (states: ${[...stateKeys].join(', ')})`,
        );
      }
    }
  }

  return problems;
};

/** Every `data-part` id the symbol's SVG body actually declares. */
export const declaredParts = (symbol: ScadaSymbolManifest): string[] => {
  const found = new Set<string>();
  const re = /data-part="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(symbol.svg))) found.add(match[1]);
  return [...found];
};
