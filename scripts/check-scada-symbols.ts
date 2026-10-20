/**
 * The SCADA symbol catalogue has to agree with itself.
 *
 *   npm run check:scada
 *
 * WHY: every one of the checks below is a symbol that saves cleanly and then
 * sits still on the diagram, which from the screen is indistinguishable from a
 * device that never reports. `tsc` sees only strings — a state naming a part
 * the SVG does not contain, or a `level` band pointing at a missing rect, is
 * type-correct and silently inert.
 *
 * No database required; everything is read from source.
 */
import {
  SCADA_BINDABLE_PROPERTIES,
  SCADA_SYMBOL_CATALOGUE,
  SCADA_SYMBOL_CATEGORIES,
  SCADA_SYMBOL_KEYS,
  SCADA_TRANSFORMS,
  applyScadaTransform,
  declaredParts,
  validateScadaBinding,
} from '../src/modules/scada/scada-symbol.catalogue';

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

console.log('\nSCADA symbol catalogue\n');

ok(
  `at least 25 symbols (${SCADA_SYMBOL_KEYS.length})`,
  SCADA_SYMBOL_KEYS.length >= 25,
  SCADA_SYMBOL_KEYS.length,
);

ok(
  'no duplicate symbol keys',
  new Set(SCADA_SYMBOL_KEYS).size === SCADA_SYMBOL_KEYS.length,
);

// ── Per symbol ───────────────────────────────────────────────────────────────
const problems: string[] = [];

for (const key of SCADA_SYMBOL_KEYS) {
  const symbol = SCADA_SYMBOL_CATALOGUE[key];
  const parts = new Set(declaredParts(symbol));
  const stateKeys = symbol.states.map((s) => s.key);

  if (!SCADA_SYMBOL_CATEGORIES.includes(symbol.category)) {
    problems.push(`${key}: category "${symbol.category}" is not declared`);
  }
  if (symbol.states.length === 0) {
    problems.push(`${key}: no states, so nothing can ever drive it`);
  }
  if (new Set(stateKeys).size !== stateKeys.length) {
    problems.push(`${key}: duplicate state keys`);
  }
  if (!stateKeys.includes(symbol.defaultState)) {
    problems.push(
      `${key}: defaultState "${symbol.defaultState}" is not one of its states`,
    );
  }
  if (symbol.width <= 0 || symbol.height <= 0) {
    problems.push(`${key}: non-positive viewBox`);
  }

  // The drift that matters: a state driving a part the SVG does not have.
  for (const state of symbol.states) {
    for (const part of Object.keys(state.parts)) {
      if (!parts.has(part)) {
        problems.push(
          `${key}: state "${state.key}" drives data-part "${part}", which the SVG does not declare`,
        );
      }
    }
    if (Object.keys(state.parts).length === 0) {
      problems.push(`${key}: state "${state.key}" changes nothing`);
    }
  }

  for (const part of symbol.stateParts) {
    if (!parts.has(part)) {
      problems.push(`${key}: stateParts lists "${part}", absent from the SVG`);
    }
  }

  // Every part a state touches must appear in stateParts, or the editor greys
  // out a part that does in fact animate.
  const touched = new Set(
    symbol.states.flatMap((s) => Object.keys(s.parts)),
  );
  for (const part of touched) {
    if (!symbol.stateParts.includes(part)) {
      problems.push(
        `${key}: "${part}" is driven by a state but missing from stateParts`,
      );
    }
  }

  if (symbol.level) {
    if (!parts.has(symbol.level.part)) {
      problems.push(
        `${key}: level band points at "${symbol.level.part}", absent from the SVG`,
      );
    }
    if (symbol.level.bottom <= symbol.level.top) {
      problems.push(`${key}: level band has bottom <= top`);
    }
    if (!symbol.bindable.includes('level')) {
      problems.push(`${key}: declares a level band but "level" is not bindable`);
    }
  }
  if (symbol.levelSweep) {
    if (!parts.has(symbol.levelSweep.part)) {
      problems.push(
        `${key}: levelSweep points at "${symbol.levelSweep.part}", absent from the SVG`,
      );
    }
    if (symbol.levelSweep.fromDeg === symbol.levelSweep.toDeg) {
      problems.push(`${key}: levelSweep has a zero-width arc`);
    }
    if (symbol.level) {
      problems.push(
        `${key}: declares both a level band and a levelSweep — the renderer cannot do both`,
      );
    }
  }
  if (
    symbol.bindable.includes('level') &&
    !symbol.level &&
    !symbol.levelSweep
  ) {
    problems.push(
      `${key}: "level" is bindable but there is neither a level band nor a needle sweep`,
    );
  }

  if (symbol.textPart && !parts.has(symbol.textPart)) {
    problems.push(
      `${key}: textPart "${symbol.textPart}" is absent from the SVG`,
    );
  }
  // A symbol WITHOUT a textPart is fine — a `text` binding there falls back to
  // the element's own label.

  for (const property of symbol.bindable) {
    if (!SCADA_BINDABLE_PROPERTIES.includes(property)) {
      problems.push(`${key}: "${property}" is not a bindable property`);
    }
  }

  // Duplicate port ids would make a connection endpoint ambiguous.
  const portIds = symbol.ports.map((p) => p.id);
  if (new Set(portIds).size !== portIds.length) {
    problems.push(`${key}: duplicate port ids`);
  }
  for (const port of symbol.ports) {
    if (port.x < -2 || port.y < -2 || port.x > symbol.width + 2 || port.y > symbol.height + 2) {
      problems.push(
        `${key}: port "${port.id}" at (${port.x},${port.y}) is outside the ${symbol.width}×${symbol.height} box`,
      );
    }
  }

  // The SVG body has to be well-formed enough to inline.
  const opens = (symbol.svg.match(/</g) ?? []).length;
  const closes = (symbol.svg.match(/>/g) ?? []).length;
  if (opens !== closes) {
    problems.push(`${key}: unbalanced angle brackets in the SVG body`);
  }
  if (/<script|onload=|onclick=|javascript:/i.test(symbol.svg)) {
    problems.push(`${key}: the SVG body contains script, which is never inlined`);
  }
}

ok('every symbol is internally consistent', problems.length === 0, problems);

// ── Transforms ───────────────────────────────────────────────────────────────
console.log('\nTransforms\n');

ok(
  'every transform descriptor applies to declared properties',
  SCADA_TRANSFORMS.every((t) =>
    t.appliesTo.every((p) => SCADA_BINDABLE_PROPERTIES.includes(p)),
  ),
);

ok(
  'threshold picks the first matching band',
  applyScadaTransform(
    {
      kind: 'threshold',
      bands: [
        { operator: 'gte', value: 90, output: 'high' },
        { operator: 'gte', value: 50, output: 'normal' },
      ],
      fallback: 'low',
    },
    95,
  ) === 'high',
);

ok(
  'threshold falls back when nothing matches',
  applyScadaTransform(
    { kind: 'threshold', bands: [{ operator: 'gt', value: 90, output: 'high' }], fallback: 'low' },
    10,
  ) === 'low',
);

ok(
  'valueMap is an exact lookup',
  applyScadaTransform(
    { kind: 'valueMap', map: { '1': 'open', '0': 'closed' }, fallback: 'partial' },
    1,
  ) === 'open',
);

ok(
  'linear rescales and clamps',
  applyScadaTransform(
    { kind: 'linear', inMin: 0, inMax: 16, outMin: 0, outMax: 100 },
    8,
  ) === 50 &&
    applyScadaTransform(
      { kind: 'linear', inMin: 0, inMax: 16, outMin: 0, outMax: 100 },
      40,
    ) === 100,
);

ok(
  'a zero-width input range does not divide by zero',
  applyScadaTransform(
    { kind: 'linear', inMin: 5, inMax: 5, outMin: 0, outMax: 100 },
    5,
  ) === 0,
);

// The strings '0' and 'false' are truthy in plain JS, and process data is full
// of both. Getting this wrong shows a stopped pump as running.
ok(
  "the strings '0' and 'false' are treated as false",
  applyScadaTransform(
    { kind: 'boolean', whenTrue: 'running', whenFalse: 'stopped' },
    '0',
  ) === 'stopped' &&
    applyScadaTransform(
      { kind: 'boolean', whenTrue: 'running', whenFalse: 'stopped' },
      'false',
    ) === 'stopped',
);

ok(
  'a missing value resolves to nothing rather than to a healthy state',
  applyScadaTransform(
    { kind: 'boolean', whenTrue: 'running', whenFalse: 'stopped' },
    null,
  ) === null,
);

ok(
  'format rounds and appends the unit',
  applyScadaTransform({ kind: 'format', decimals: 1, unit: 'bar' }, 7.449) ===
    '7.4 bar',
);

// ── Binding validation ───────────────────────────────────────────────────────
console.log('\nBinding validation\n');

ok(
  'a state output that is not a state of the symbol is refused',
  validateScadaBinding('pump_centrifugal', {
    property: 'state',
    source: 'telemetry',
    deviceId: '00000000-0000-4000-8000-000000000000',
    key: 'run',
    transform: { kind: 'boolean', whenTrue: 'spinning', whenFalse: 'stopped' },
  }).some((p) => p.includes('spinning')),
);

ok(
  'a valid pump run binding passes',
  validateScadaBinding('pump_centrifugal', {
    property: 'state',
    source: 'telemetry',
    deviceId: '00000000-0000-4000-8000-000000000000',
    key: 'run',
    transform: { kind: 'boolean', whenTrue: 'running', whenFalse: 'stopped' },
  }).length === 0,
);

ok(
  'a level binding on a symbol with no level band is refused',
  validateScadaBinding('indicator_lamp', {
    property: 'level',
    source: 'telemetry',
    deviceId: '00000000-0000-4000-8000-000000000000',
    key: 'pct',
  }).length > 0,
);

ok(
  'a level binding on a tank passes',
  validateScadaBinding('tank_vertical', {
    property: 'level',
    source: 'telemetry',
    deviceId: '00000000-0000-4000-8000-000000000000',
    key: 'level',
    transform: { kind: 'linear', inMin: 0, inMax: 10, outMin: 0, outMax: 100 },
  }).length === 0,
);

ok(
  'a telemetry binding without a device or key is refused',
  validateScadaBinding('tank_vertical', {
    property: 'state',
    source: 'telemetry',
  }).length >= 2,
);

ok(
  'an unknown symbol is refused',
  validateScadaBinding('no_such_symbol', {
    property: 'state',
    source: 'telemetry',
  }).length > 0,
);

// ── Coverage: the symbol set a mimic diagram actually needs ──────────────────
console.log('\nCoverage\n');

const required = [
  'pump_centrifugal',
  'motor',
  'valve_2way',
  'valve_3way',
  'tank_vertical',
  'pipe_segment',
  'pipe_elbow',
  'pipe_tee',
  'heat_exchanger',
  'fan',
  'compressor',
  'boiler',
  'chiller',
  'generator',
  'circuit_breaker',
  'transformer',
  'busbar',
  'sensor_transmitter',
  'gauge',
  'indicator_lamp',
  'push_button',
  'selector_switch',
  'conveyor',
  'mixer_agitator',
  'filter',
  'flow_meter',
];

const missing = required.filter((key) => !SCADA_SYMBOL_CATALOGUE[key]);
ok('every required symbol is present', missing.length === 0, missing);

const spinners = SCADA_SYMBOL_KEYS.filter((key) =>
  SCADA_SYMBOL_CATALOGUE[key].states.some((s) =>
    Object.values(s.parts).some((p) => (p.spin ?? 0) !== 0),
  ),
);
ok(
  `at least six symbols have a genuinely rotating part (${spinners.length})`,
  spinners.length >= 6,
  spinners,
);

const blinkers = SCADA_SYMBOL_KEYS.filter((key) =>
  SCADA_SYMBOL_CATALOGUE[key].states.some((s) =>
    Object.values(s.parts).some((p) => (p.blink ?? 0) > 0),
  ),
);
ok(
  `fault states blink on at least ten symbols (${blinkers.length})`,
  blinkers.length >= 10,
  blinkers,
);

const levelled = SCADA_SYMBOL_KEYS.filter((k) => SCADA_SYMBOL_CATALOGUE[k].level);
ok(`at least three symbols carry a level band (${levelled.length})`, levelled.length >= 3, levelled);

const actionable = SCADA_SYMBOL_KEYS.filter((k) =>
  SCADA_SYMBOL_CATALOGUE[k].bindable.includes('action'),
);
ok(
  `write-back is offered on at least five symbols (${actionable.length})`,
  actionable.length >= 5,
);

console.log(
  failures === 0
    ? `\nAll checks passed — ${SCADA_SYMBOL_KEYS.length} symbols.\n`
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
