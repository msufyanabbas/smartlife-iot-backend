import { Injectable, Logger } from '@nestjs/common';
import {
  CUT_PLANE_MM,
  DEFAULT_FLOOR_TO_FLOOR_MM,
  DIMENSION_RULES,
  HIDDEN_LINETYPES,
  LAYER_RULES,
  LAYER_RULE_INDEX,
  LINETYPES,
  LINE_WEIGHTS,
  PRACTICE_RULES,
  REFERENCE_STANDARDS,
  SYMBOL_INDEX,
  SYMBOL_RULES,
  STANDARD_UNITS,
  type CadRole,
  type LayerRule,
  type MountPlane,
  type SolidBehaviour,
} from './cad-standard.catalogue';
import {
  DISCIPLINES,
  STATUS_CODES,
  layerKeyWithoutStatus,
  parseLayerName,
  type NcsStatus,
} from './ncs-layer';

/** The verdict for one layer in an uploaded drawing. */
export interface LayerClassification {
  layer: string;
  role: CadRole;
  solid: SolidBehaviour;
  /** Set when the layer resolved to a catalogue entry. */
  matchedRule?: string;
  /** How the decision was reached — shown in the report so it is auditable. */
  basis: 'exact' | 'major-group' | 'status' | 'discipline' | 'unknown';
  status: NcsStatus;
  statusLabel: string;
  conformant: boolean;
  thicknessMm?: number;
  heightMm?: number;
  sillMm?: number;
  /** Set for marker/route layers, and for build layers above the cut plane. */
  mount?: MountPlane;
  mountMm?: number;
  sizeMm?: number;
  description: string;
  /** Present whenever solid === 'ignore'. */
  ignoreReason?: string;
}

export interface ComplianceInput {
  /** Layer name → how many entities sit on it. */
  layers: Array<{ name: string; entityCount?: number; linetype?: string }>;
  /** Block names used by INSERT entities, if known. */
  blocks?: string[];
  /** Drawing units if the file declares them ($INSUNITS). */
  units?: string;
}

export interface ComplianceReport {
  summary: {
    totalLayers: number;
    conformant: number;
    nonConformant: number;
    willBuild: number;
    willVoid: number;
    willMarker: number;
    willRoute: number;
    willIgnore: number;
    recognisedSymbols: number;
    unknownSymbols: number;
    score: number;
  };
  layers: LayerClassification[];
  /** Layers the standard does not describe — the actionable list. */
  unrecognised: Array<{ layer: string; entityCount: number; issue: string; suggestion?: string }>;
  symbols: Array<{ block: string; recognised: boolean; label?: string; layer?: string; deviceHint?: string }>;
  warnings: string[];
  practiceRules: readonly string[];
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The standard, applied
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One service answers three questions, all from the same catalogue:
 *
 *   classify(layer)  — what is this, and does it become geometry?
 *   validate(input)  — does this drawing follow the standard, and what will
 *                      be silently dropped if it does not?
 *   getStandard()    — the whole thing, for the reference screen.
 *
 * The second is the one that earns its keep. Importing a CAD file is a
 * lossy, opinionated operation, and the failure mode is silent: the model
 * comes out subtly wrong and nobody can say which layer caused it. The
 * report makes every decision visible BEFORE the model is built.
 */
@Injectable()
export class CadStandardsService {
  private readonly logger = new Logger(CadStandardsService.name);

  // ══════════════════════════════════════════════════════════════════════════
  // CLASSIFY
  // ══════════════════════════════════════════════════════════════════════════

  classify(layerName: string, linetype?: string): LayerClassification {
    const parsed = parseLayerName(layerName);
    const statusLabel = STATUS_CODES[parsed.status];

    const build = (
      rule: LayerRule,
      basis: LayerClassification['basis'],
    ): LayerClassification => {
      let solid = rule.solid;
      let ignoreReason = rule.ignoreReason;

      // ── Status overrides the catalogue ──────────────────────────────────
      //
      // A wall is a wall, but `A-WALL-DEMO` is a wall that will not exist
      // once the works are done, and `A-WALL-FUTR` is one that does not
      // exist yet. Building either models a building that is never real at
      // any single moment in time.
      if (
        solid !== 'ignore' &&
        (parsed.status === 'DEMO' || parsed.status === 'FUTR')
      ) {
        solid = 'ignore';
        ignoreReason =
          parsed.status === 'DEMO'
            ? 'Status -DEMO: scheduled for demolition, so it is not part of the finished building.'
            : 'Status -FUTR: future work, not built yet.';
      }

      // ── Linetype is a secondary signal ──────────────────────────────────
      //
      // "Dashed 0.18 — Hidden / ABOVE cut (beams, stairs above, overhangs)".
      // A dashed line on a solid layer is something seen through or above
      // the cut plane, not a wall at this level.
      //
      // Unless the rule ALREADY KNOWS that. `S-BEAM` and `A-FLOR-STRS-ABOV`
      // are specified dashed BY the standard precisely because they are above
      // the cut — and they carry a `mount` saying what height to build them
      // at. For those, a dashed linetype confirms what the catalogue already
      // encodes; treating it as new information would discard the elevation
      // and drop the geometry, which is the bug this whole pass is fixing.
      //
      // So the override applies only where the rule has no elevation of its
      // own, i.e. where dashed genuinely means "we don't know where this is".
      if (
        solid === 'build' &&
        rule.mount === undefined &&
        linetype &&
        HIDDEN_LINETYPES.has(linetype.toUpperCase())
      ) {
        solid = 'ignore';
        ignoreReason =
          `Drawn with linetype ${linetype}, which the standard reserves for ` +
          'hidden geometry or objects above the cut plane, and the layer ' +
          'carries no mounting height to build it at instead.';
      }

      return {
        layer: layerName,
        role: rule.role,
        solid,
        matchedRule: rule.layer,
        basis,
        status: parsed.status,
        statusLabel,
        conformant: parsed.conformant,
        thicknessMm: rule.thicknessMm,
        heightMm: rule.heightMm,
        sillMm: rule.sillMm,
        mount: rule.mount,
        mountMm: rule.mountMm,
        sizeMm: rule.sizeMm,
        description: rule.description,
        ignoreReason: solid === 'ignore' ? ignoreReason : undefined,
      };
    };

    // 1. Exact match on the full key, status stripped.
    const key = layerKeyWithoutStatus(layerName);
    const exact = LAYER_RULE_INDEX.get(key);
    if (exact) return build(exact, 'exact');

    // 2. Fall back to Discipline-Major. `A-WALL-SOMETHINGNEW` is still a
    //    wall; inventing a minor group should not make it unclassifiable.
    if (parsed.conformant && parsed.discipline && parsed.major) {
      const majorKey = `${parsed.discipline}-${parsed.major}`;
      const byMajor = LAYER_RULE_INDEX.get(majorKey);
      if (byMajor) return build(byMajor, 'major-group');

      // 3. Any rule that starts with the same major group, e.g.
      //    A-FLOR-SOMETHING → the A-FLOR family, which is floor geometry.
      const family = LAYER_RULES.find((r) => r.layer.startsWith(`${majorKey}-`));
      if (family) return build({ ...family, thicknessMm: undefined }, 'major-group');

      // 4. Known discipline, unknown content. Services never become walls:
      //    an unrecognised T-/E-/M-/P-/F-/FA-/B- layer is some service, and
      //    extruding it would put a block through the building.
      const servicesDisciplines = ['T', 'E', 'M', 'P', 'F', 'FA', 'B'];
      if (servicesDisciplines.includes(parsed.discipline)) {
        return {
          layer: layerName,
          role: 'device',
          solid: 'ignore',
          basis: 'discipline',
          status: parsed.status,
          statusLabel,
          conformant: true,
          description: `${DISCIPLINES[parsed.discipline]} — minor group "${parsed.minor ?? parsed.major}" is not in the standard.`,
          ignoreReason:
            'A services layer the standard does not list. Services are ' +
            'symbols and routes, never building fabric, so it is left out ' +
            'of the solid model rather than guessed at.',
        };
      }

      if (parsed.discipline === 'G') {
        return {
          layer: layerName,
          role: 'annotation',
          solid: 'ignore',
          basis: 'discipline',
          status: parsed.status,
          statusLabel,
          conformant: true,
          description: 'General / annotation discipline.',
          ignoreReason: 'Everything in the G discipline is annotation.',
        };
      }
    }

    // 5. Unknown. Ignored rather than guessed — a wrong solid is worse than
    //    a missing one, because a missing one is visible.
    return {
      layer: layerName,
      role: 'annotation',
      solid: 'ignore',
      basis: 'unknown',
      status: parsed.status,
      statusLabel,
      conformant: parsed.conformant,
      description: parsed.issue ?? 'Layer is not described by the standard.',
      ignoreReason:
        parsed.issue ??
        'Not in the standard. It is excluded rather than guessed at — a ' +
        'wrong solid is harder to spot than a missing one.',
    };
  }

  classifySymbol(blockName: string) {
    const rule = SYMBOL_INDEX.get((blockName ?? '').trim().toUpperCase());
    return rule
      ? { block: blockName, recognised: true, label: rule.label, layer: rule.layer, deviceHint: rule.deviceHint }
      : { block: blockName, recognised: false };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATE
  // ══════════════════════════════════════════════════════════════════════════

  validate(input: ComplianceInput): ComplianceReport {
    const layers = (input.layers ?? []).filter((l) => l?.name);
    const classifications = layers.map((l) => this.classify(l.name, l.linetype));

    const counts: Record<SolidBehaviour, number> = {
      build: 0,
      void: 0,
      marker: 0,
      route: 0,
      ignore: 0,
    };
    for (const c of classifications) counts[c.solid]++;

    const unrecognised = classifications
      .filter((c) => c.basis === 'unknown')
      .map((c) => {
        const src = layers.find((l) => l.name === c.layer);
        return {
          layer: c.layer,
          entityCount: src?.entityCount ?? 0,
          issue: c.description,
          suggestion: this.suggestLayer(c.layer),
        };
      })
      // The layers carrying the most geometry matter most.
      .sort((a, b) => b.entityCount - a.entityCount);

    const symbols = (input.blocks ?? [])
      // Anonymous blocks (*D1, *Model_Space, *Paper_Space) are AutoCAD's own
      // bookkeeping, not drawing content.
      .filter((b) => b && !b.startsWith('*'))
      .map((b) => this.classifySymbol(b));

    const warnings: string[] = [];

    if (input.units && !/mm|millimet/i.test(input.units)) {
      warnings.push(
        `Drawing units are "${input.units}" but the standard is millimetres ` +
          `at 1:1. Every dimension below will be wrong by a constant factor.`,
      );
    }

    for (const reserved of ['0', 'Defpoints']) {
      const hit = layers.find(
        (l) => l.name.toLowerCase() === reserved.toLowerCase() && (l.entityCount ?? 0) > 0,
      );
      if (hit) {
        warnings.push(
          `${hit.entityCount} entities are on "${hit.name}". The standard ` +
            `says nothing should be drawn on layer 0 or Defpoints in model ` +
            `space, so none of it can be classified.`,
        );
      }
    }

    // "Nothing will be built" is only alarming if nothing physical comes out
    // at all. A services-only drawing that yields markers and routes is a
    // perfectly good import, so it must not trigger the empty-model warning.
    if (counts.build + counts.marker + counts.route === 0) {
      warnings.push(
        'No layer in this drawing produces any physical geometry, so the 3D ' +
          'model would be empty. Check that walls are on A-WALL (or an A-3D-* ' +
          'layer) rather than a custom layer name.',
      );
    } else if (counts.build === 0) {
      warnings.push(
        `This drawing produces no building fabric — no walls, slabs or ` +
          `columns — but does produce ${counts.marker} device layer(s) and ` +
          `${counts.route} service route layer(s). That is expected for a ` +
          `services-only drawing, and the model will have equipment floating ` +
          `without a shell around it. Import the architectural plan for the ` +
          `same level to give it context.`,
      );
    }

    const nonConformant = classifications.filter((c) => !c.conformant).length;
    const conformant = classifications.length - nonConformant;
    const unknownSymbols = symbols.filter((s) => !s.recognised).length;

    // Share of ENTITIES on classified layers, not share of layer names: a
    // drawing with one unrecognised layer holding 90% of the geometry is not
    // 95% compliant.
    const totalEntities = layers.reduce((n, l) => n + (l.entityCount ?? 0), 0);
    const classifiedEntities = layers.reduce((n, l) => {
      const c = classifications.find((x) => x.layer === l.name);
      return c && c.basis !== 'unknown' ? n + (l.entityCount ?? 0) : n;
    }, 0);
    const score = totalEntities === 0 ? 0 : Math.round((classifiedEntities / totalEntities) * 100);

    return {
      summary: {
        totalLayers: classifications.length,
        conformant,
        nonConformant,
        willBuild: counts.build,
        willVoid: counts.void,
        willMarker: counts.marker,
        willRoute: counts.route,
        willIgnore: counts.ignore,
        recognisedSymbols: symbols.length - unknownSymbols,
        unknownSymbols,
        score,
      },
      layers: classifications,
      unrecognised,
      symbols,
      warnings,
      practiceRules: PRACTICE_RULES,
    };
  }

  /** Nearest standard layer, by discipline and a crude keyword match. */
  private suggestLayer(layerName: string): string | undefined {
    const n = (layerName ?? '').toLowerCase();
    const guesses: Array<[RegExp, string]> = [
      [/wall|mur|wand|muro|جدار/, 'A-WALL'],
      [/partition|prtn/, 'A-WALL-PRTN'],
      [/door|porte|tur|puerta|باب/, 'A-DOOR'],
      [/window|glaz|fenetre|fenster|ventana|نافذة/, 'A-GLAZ'],
      [/column|col|pilier|saule/, 'A-COLS'],
      [/beam|poutre/, 'S-BEAM'],
      [/stair|escalier|treppe|escalera|درج/, 'A-FLOR-STRS'],
      [/slab|dalle|floor/, 'A-3D-SLAB'],
      [/rail|hrail|hral|guard/, 'A-FLOR-HRAL'],
      [/lift|elev/, 'A-FLOR-EVTR'],
      [/room|area|space/, 'A-AREA-IDEN'],
      [/grid|axe/, 'G-GRID'],
      [/dim/, 'G-ANNO-DIMS'],
      [/text|note|anno/, 'G-ANNO-TEXT'],
      [/furn/, 'A-FURN'],
      [/camera|cctv/, 'T-CCTV'],
      [/light|lum/, 'E-LITE'],
      [/power|socket|outlet/, 'E-POWR'],
    ];
    for (const [re, layer] of guesses) if (re.test(n)) return layer;
    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REFERENCE
  // ══════════════════════════════════════════════════════════════════════════

  getStandard() {
    return {
      units: STANDARD_UNITS,
      cutPlaneMm: CUT_PLANE_MM,
      defaultFloorToFloorMm: DEFAULT_FLOOR_TO_FLOOR_MM,
      disciplines: Object.entries(DISCIPLINES).map(([code, label]) => ({ code, label })),
      statusCodes: Object.entries(STATUS_CODES).map(([code, label]) => ({ code, label })),
      layers: LAYER_RULES,
      symbols: SYMBOL_RULES,
      dimensionRules: DIMENSION_RULES,
      lineWeights: LINE_WEIGHTS,
      linetypes: LINETYPES,
      practiceRules: PRACTICE_RULES,
      referenceStandards: REFERENCE_STANDARDS,
    };
  }

  /**
   * Check a proposed stair against the library's design rules.
   *
   * Separate from layer classification because it answers a different
   * question — not "what is this line" but "is this stair legal". LIB-04
   * prints the numbers and tells the reader to check the local code, which
   * is why every failure cites its source rather than just saying no.
   */
  checkStair(input: { riserMm: number; goingMm: number; widthMm?: number; flightRiseMm?: number }) {
    const issues: Array<{ rule: string; message: string; severity: 'error' | 'warning' }> = [];
    const r = Number(input.riserMm);
    const g = Number(input.goingMm);

    const rule = (key: string) => DIMENSION_RULES.find((d) => d.key === key)!;

    const riser = rule('stair.riser');
    if (r < riser.min! || r > riser.max!) {
      issues.push({ rule: riser.key, severity: 'error',
        message: `Riser ${r} is outside ${riser.min}-${riser.max} mm. ${riser.note}` });
    }
    const going = rule('stair.going');
    if (g < going.min!) {
      issues.push({ rule: going.key, severity: 'error',
        message: `Going ${g} is below the ${going.min} mm minimum. ${going.note}` });
    }
    const comfort = rule('stair.comfort');
    const blondel = 2 * r + g;
    if (blondel < comfort.min! || blondel > comfort.max!) {
      issues.push({ rule: comfort.key, severity: 'warning',
        message: `2R + G = ${blondel}, outside the comfortable ${comfort.min}-${comfort.max} mm. ${comfort.note}` });
    }
    const pitchDeg = (Math.atan2(r, g) * 180) / Math.PI;
    const pitch = rule('stair.pitch');
    if (pitchDeg > pitch.max!) {
      issues.push({ rule: pitch.key, severity: 'error',
        message: `Pitch ${pitchDeg.toFixed(1)} degrees exceeds ${pitch.max}. ${pitch.note}` });
    }
    if (input.widthMm != null) {
      const w = rule('stair.clearWidth');
      if (input.widthMm < w.min!) {
        issues.push({ rule: w.key, severity: 'warning',
          message: `Clear width ${input.widthMm} is below ${w.min} mm. ${w.note}` });
      }
    }
    if (input.flightRiseMm != null) {
      const fr = rule('stair.risePerFlight');
      if (input.flightRiseMm > fr.max!) {
        issues.push({ rule: fr.key, severity: 'error',
          message: `Rise per flight ${input.flightRiseMm} exceeds ${fr.max} mm. ${fr.note}` });
      }
    }

    return {
      compliant: issues.every((i) => i.severity !== 'error'),
      pitchDeg: Number(pitchDeg.toFixed(2)),
      blondel,
      issues,
    };
  }
}
