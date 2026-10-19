/**
 * ─────────────────────────────────────────────────────────────────────────────
 * NCS / ISO 13567 layer-name grammar
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The master template states the rule verbatim:
 *
 *   "7. LAYER NAMING - NCS: Discipline - Major group - Minor group - Status
 *    (e.g. E-LITE-CIRC-NEWW)"
 *   "Status modifiers (NCS): -NEWW new, -EXST existing, -DEMO demolish,
 *    -FUTR future, -TEMP temporary, -MOVE relocate"
 *
 * Parsing the NAME is the whole trick. A drawing that follows the standard
 * already says what every entity IS — `A-WALL-PRTN-DEMO` is an architectural
 * partition marked for demolition — and that is strictly better information
 * than guessing from geometry. The existing importer matched layer names with
 * loose regexes (`/^wall/i`, `/^a-wall/i`, …), which cannot tell a wall from a
 * wall that is being torn out, and has no idea that `A-WALL-PATT` is a hatch
 * pattern rather than a wall.
 */

/** Discipline codes, from the master template's table in section 7. */
export const DISCIPLINES: Record<string, string> = {
  G: 'General / annotation',
  A: 'Architectural',
  S: 'Structural',
  M: 'Mechanical / HVAC',
  P: 'Plumbing',
  F: 'Fire protection',
  E: 'Electrical',
  FA: 'Fire alarm',
  T: 'Telecom / ELV / security',
  B: 'BMS / controls',
  C: 'Civil',
  L: 'Landscape',
  I: 'Interiors',
  Q: 'Equipment',
  X: 'Other / unassigned',
};

/**
 * Status suffixes. `NEWW` is the default when none is given — the standard
 * only requires the modifier for the non-default cases.
 */
export const STATUS_CODES = {
  NEWW: 'new',
  EXST: 'existing',
  DEMO: 'to be demolished',
  FUTR: 'future',
  TEMP: 'temporary',
  MOVE: 'to be relocated',
} as const;

export type NcsStatus = keyof typeof STATUS_CODES;

export interface ParsedLayerName {
  /** The name exactly as it appeared. */
  raw: string;
  discipline?: string;
  disciplineLabel?: string;
  major?: string;
  minor?: string;
  /** Further groups beyond minor, e.g. the ABOV in A-FLOR-STRS-ABOV. */
  extra: string[];
  status: NcsStatus;
  /** False when the name does not parse as Discipline-Major[-Minor…]. */
  conformant: boolean;
  /** Why it is non-conformant, for the compliance report. */
  issue?: string;
}

const STATUS_SET = new Set(Object.keys(STATUS_CODES));

/**
 * Two-letter disciplines have to be tried before one-letter ones, or `FA-DEVC`
 * parses as discipline `F` with major `A`, i.e. a fire-protection layer rather
 * than a fire-alarm one. The master template lists FA explicitly as an "NCS
 * secondary code", so it is a real two-character discipline and not a typo.
 */
const TWO_CHAR = ['FA'];

export function parseLayerName(raw: string): ParsedLayerName {
  const name = (raw ?? '').trim();
  const base: ParsedLayerName = { raw: name, extra: [], status: 'NEWW', conformant: false };

  if (!name) return { ...base, issue: 'empty layer name' };

  // Layer 0 and Defpoints are legitimate AutoCAD fixtures, not NCS names.
  // The template's practice rules say "Do not draw on layer 0 or Defpoints in
  // model space", so they are recognised in order to be REPORTED, not parsed.
  if (name === '0' || name.toLowerCase() === 'defpoints') {
    return { ...base, issue: `reserved layer "${name}" — nothing should be drawn here in model space` };
  }

  const parts = name.toUpperCase().split('-').filter(Boolean);
  if (parts.length < 2) {
    return { ...base, issue: 'expected at least Discipline-Major (e.g. A-WALL)' };
  }

  let discipline: string;
  let rest: string[];
  if (TWO_CHAR.includes(parts[0])) {
    discipline = parts[0];
    rest = parts.slice(1);
  } else if (parts[0].length === 1) {
    discipline = parts[0];
    rest = parts.slice(1);
  } else {
    return { ...base, issue: `"${parts[0]}" is not a discipline code` };
  }

  if (!DISCIPLINES[discipline]) {
    return { ...base, issue: `unknown discipline "${discipline}"` };
  }

  // A trailing status modifier is consumed before major/minor are read.
  let status: NcsStatus = 'NEWW';
  if (rest.length > 1 && STATUS_SET.has(rest[rest.length - 1])) {
    status = rest.pop() as NcsStatus;
  }

  if (rest.length === 0) {
    return { ...base, discipline, issue: 'missing major group' };
  }

  return {
    raw: name,
    discipline,
    disciplineLabel: DISCIPLINES[discipline],
    major: rest[0],
    minor: rest[1],
    extra: rest.slice(2),
    status,
    conformant: true,
  };
}

/** `A-WALL-PRTN-DEMO` → `A-WALL-PRTN`. Used for catalogue lookup. */
export function layerKeyWithoutStatus(raw: string): string {
  const p = parseLayerName(raw);
  if (!p.conformant) return (raw ?? '').trim().toUpperCase();
  return [p.discipline, p.major, p.minor, ...p.extra].filter(Boolean).join('-');
}
