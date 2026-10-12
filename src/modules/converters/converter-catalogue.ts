import { ConverterDirection, ConverterType } from './converter.enums';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The converter catalogue, declared once on the server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Modelled on `rules/rule-node-catalogue.ts` rather than
 * `integrations/integration-catalogue.ts`. The reason is which members of each
 * actually carry weight here:
 *
 *   - rule-node-catalogue's distinguishing parts are a rich field-type union
 *     (`script`, `json`, `keyvalue` — editors, not inputs) and a
 *     `validate…Config() → string[]` that reports every problem at once. A
 *     converter form is a mapping table plus a code editor; those are exactly
 *     the widgets that union names, and the mapping table is why a `mapping`
 *     member is added to it here.
 *   - integration-catalogue's distinguishing parts (`hasAdapter`,
 *     `inboundPath`, `defaultProtocol`) describe a *transport*. A converter has
 *     no endpoint and no wire of its own, so all three would be dead fields.
 *
 * Every `fields[].key` below was taken from the code that reads it in
 * `converter-execution.service.ts`. `configuration` is a free jsonb column, so
 * a typo'd key saves cleanly with a 201 and the converter then behaves as if
 * unconfigured — which is the whole reason the form is generated from here
 * instead of hand-written in the frontend.
 *
 * `directions` is the other half: a `codec` converter can do both ways
 * (CodecRegistryService has `decode` and `encode`), a `json` mapping is
 * declared per direction, and the UI must not offer a direction the executor
 * will refuse.
 */

export type ConverterFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'script'
  | 'keyvalue'
  /** The source-path → target-key table. See JsonMappingRule below. */
  | 'mapping';

export interface ConverterFieldOption {
  value: string;
  label: string;
}

export interface ConverterConfigField {
  key: string;
  label: string;
  type: ConverterFieldType;
  required?: boolean;
  placeholder?: string;
  /** Shown under the input. Say what the value is FOR, not what it is called. */
  help?: string;
  default?: unknown;
  options?: ConverterFieldOption[];
  /** Groups fields into sections in the form. */
  group?: string;
  min?: number;
  max?: number;
  /** Render only when another field holds one of these values. */
  showIf?: { key: string; equals: Array<string | number | boolean> };
}

export interface ConverterTypeManifest {
  type: ConverterType;
  label: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  /** Directions this type can actually execute. */
  directions: ConverterDirection[];
  /**
   * What `output` looks like, in one line, for the test panel's empty state.
   */
  outputShape: string;
  fields: ConverterConfigField[];
}

/**
 * One row of a `json` converter's mapping table.
 *
 * `source` is a dot path into the incoming payload — `object.temperature`,
 * `uplink_message.decoded_payload.temp`, `readings.0.value` and
 * `readings[0].value` all resolve.
 */
export interface JsonMappingRule {
  source: string;
  target: string;
  /** Multiplied in after the cast. `0.1` turns a raw deci-degree into °C. */
  scale?: number;
  /** Added after scaling. */
  offset?: number;
  cast?: 'number' | 'integer' | 'string' | 'boolean';
  /** Unit label carried into the output's `$units` sidecar, for the UI. */
  unit?: string;
  /** Fail the conversion when the source path is absent. */
  required?: boolean;
  /** Used when the source path is absent and the rule is not required. */
  default?: unknown;
}

const CAST_OPTIONS: ConverterFieldOption[] = [
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'string', label: 'String' },
  { value: 'boolean', label: 'Boolean' },
];

const timeoutField = (): ConverterConfigField => ({
  key: 'timeout',
  label: 'Timeout (ms)',
  type: 'number',
  default: 2000,
  min: 50,
  max: 10000,
  group: 'Advanced',
  help: 'The sandbox is interrupted after this long. Clamped server-side to 10s.',
});

export const CONVERTER_CATALOGUE: Record<ConverterType, ConverterTypeManifest> =
  {
    // ── JSON ─────────────────────────────────────────────────────────────────
    [ConverterType.JSON]: {
      type: ConverterType.JSON,
      label: 'JSON field mapping',
      description:
        'Pick values out of the payload by path and write them to telemetry keys. Dot paths, unit scaling and a type cast per field — no code.',
      icon: 'Braces',
      directions: [ConverterDirection.UPLINK, ConverterDirection.DOWNLINK],
      outputShape:
        'An object whose keys are the `target` of each mapping that matched.',
      fields: [
        {
          key: 'mappings',
          label: 'Field mappings',
          type: 'mapping',
          required: true,
          help:
            'One row per telemetry key. `source` is a dot path into the payload ' +
            '(object.temperature, readings.0.value, readings[0].value all work); ' +
            '`target` is the key written out. `scale` and `offset` are applied ' +
            'after the cast, so scale 0.1 turns 308 into 30.8.',
        },
        {
          key: 'deviceKeyPath',
          label: 'Device identity path',
          type: 'text',
          group: 'Routing',
          placeholder: 'end_device_ids.device_id',
          help:
            'Where the device identifier sits in the payload. Reported in the ' +
            'result as `deviceKey` so an uplink can be routed; it is not written ' +
            'into telemetry.',
        },
        {
          key: 'timestampPath',
          label: 'Timestamp path',
          type: 'text',
          group: 'Routing',
          placeholder: 'received_at',
          help:
            'Where the reading time sits. Accepts an ISO string or epoch ' +
            'seconds/milliseconds; absent or unparseable means "now".',
        },
        {
          key: 'includeUnmapped',
          label: 'Also copy through unmapped top-level keys',
          type: 'boolean',
          default: false,
          group: 'Advanced',
          help:
            'Off by default: a converter whose point is to produce a known shape ' +
            'should not quietly pass through whatever else the vendor sent.',
        },
        {
          key: 'stripNulls',
          label: 'Drop null and undefined results',
          type: 'boolean',
          default: true,
          group: 'Advanced',
          help: 'Keeps a sensor that reported nothing from writing a null reading.',
        },
      ],
    },

    // ── SCRIPT ───────────────────────────────────────────────────────────────
    [ConverterType.SCRIPT]: {
      type: ConverterType.SCRIPT,
      label: 'Script',
      description:
        'A JavaScript expression over the payload, for shapes a mapping table cannot express. Runs in a vm2 sandbox with no Node globals.',
      icon: 'Code',
      directions: [ConverterDirection.UPLINK, ConverterDirection.DOWNLINK],
      outputShape: 'Whatever object the script returns.',
      fields: [
        {
          key: 'script',
          label: 'Script',
          type: 'script',
          required: true,
          placeholder:
            'return {\n  temperature: payload.temp / 10,\n  humidity: payload.hum,\n};',
          help:
            '`payload` is the incoming message and `metadata` the context ' +
            '(deviceKey, fPort…). Return an object. `require`, `process`, ' +
            '`fetch`, `Buffer` and the filesystem are absent, not merely ' +
            'discouraged — referencing one is a ReferenceError.',
        },
        {
          key: 'deviceKeyPath',
          label: 'Device identity path',
          type: 'text',
          group: 'Routing',
          placeholder: 'end_device_ids.device_id',
          help: 'Read from the INPUT payload, before the script runs.',
        },
        timeoutField(),
      ],
    },

    // ── CODEC ────────────────────────────────────────────────────────────────
    [ConverterType.CODEC]: {
      type: ConverterType.CODEC,
      label: 'Device codec',
      description:
        'Hand the payload to a registered device codec. This is how the 80+ Milesight codecs already in the platform become reachable from a converter — nothing is re-decoded here.',
      icon: 'Cpu',
      directions: [ConverterDirection.UPLINK, ConverterDirection.DOWNLINK],
      outputShape:
        "The codec's own decoded telemetry (uplink) or `{fPort, data, confirmed}` (downlink).",
      fields: [
        {
          key: 'codecId',
          label: 'Codec',
          type: 'text',
          group: 'Codec selection',
          placeholder: 'milesight-em300-th',
          help:
            'The fastest and least surprising path. Pick from ' +
            'GET /codecs/manufacturers. Takes precedence over ' +
            'manufacturer + model below.',
        },
        {
          key: 'manufacturer',
          label: 'Manufacturer',
          type: 'text',
          group: 'Codec selection',
          placeholder: 'Milesight',
          help: 'Used with Model when no codec is named.',
        },
        {
          key: 'model',
          label: 'Model',
          type: 'text',
          group: 'Codec selection',
          placeholder: 'EM300-TH',
        },
        {
          key: 'payloadPath',
          label: 'Payload path',
          type: 'text',
          group: 'Payload',
          placeholder: 'data',
          help:
            'Where the hex/base64 frame sits inside the message — `data` for a ' +
            'ChirpStack uplink, `uplink_message.frm_payload` for TTN. Leave ' +
            'empty when the message IS the frame.',
        },
        {
          key: 'fPort',
          label: 'fPort',
          type: 'number',
          group: 'Payload',
          min: 0,
          max: 255,
          help: 'LoRaWAN port, passed to the codec. Overridden by the per-message value when one is supplied.',
        },
        {
          key: 'allowAutoDetect',
          label: 'Fall back to auto-detection',
          type: 'boolean',
          default: false,
          group: 'Advanced',
          help:
            'Off by default. With it on, an unrecognised payload is probed ' +
            "against every registered codec and the first that claims it wins — " +
            'convenient while exploring, but it makes the converter silently ' +
            'change behaviour when a codec is added.',
        },
        {
          key: 'commandType',
          label: 'Default command type',
          type: 'text',
          group: 'Downlink',
          placeholder: 'reboot',
          help:
            'Downlink only, and only as a fallback: a command is normally named ' +
            'per call as `{type, params}`.',
        },
      ],
    },
  };

/** Catalogue order: the type you reach for first, first. */
export const listConverterCatalogue = (): ConverterTypeManifest[] => {
  const order: ConverterType[] = [
    ConverterType.JSON,
    ConverterType.CODEC,
    ConverterType.SCRIPT,
  ];
  return order.map((t) => CONVERTER_CATALOGUE[t]).filter(Boolean);
};

/**
 * Validate a converter's configuration against its manifest.
 *
 * Returns messages rather than throwing, so the caller reports every problem in
 * one response instead of one per round trip — a form that fixes one field per
 * save is miserable to use. Only declared fields are checked; extra keys pass,
 * because `configuration` is a free jsonb column.
 */
export const validateConverterConfig = (
  type: ConverterType,
  direction: ConverterDirection,
  configuration: Record<string, unknown> | undefined | null,
): string[] => {
  const manifest = CONVERTER_CATALOGUE[type];
  if (!manifest) return [`Unknown converter type "${type}"`];

  const config = configuration ?? {};
  const errors: string[] = [];

  if (!manifest.directions.includes(direction)) {
    errors.push(
      `${manifest.label} cannot run ${direction}; supported: ${manifest.directions.join(', ')}`,
    );
  }

  for (const field of manifest.fields) {
    if (field.showIf) {
      const governing = config[field.showIf.key];
      // Compared as strings: a select stores "true" where the manifest may
      // declare the boolean true, and the two must still match.
      const applies = field.showIf.equals.some(
        (candidate) => String(candidate) === String(governing),
      );
      if (!applies) continue;
    }

    const value = config[field.key];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);

    if (field.required && empty) {
      errors.push(`${manifest.label}: "${field.label}" is required`);
      continue;
    }
    if (empty) continue;

    if (field.type === 'number') {
      const numeric = typeof value === 'string' ? Number(value) : value;
      if (typeof numeric !== 'number' || Number.isNaN(numeric)) {
        errors.push(`"${field.label}" must be a number`);
        continue;
      }
      if (field.min !== undefined && numeric < field.min) {
        errors.push(`"${field.label}" must be at least ${field.min}`);
      }
      if (field.max !== undefined && numeric > field.max) {
        errors.push(`"${field.label}" must be at most ${field.max}`);
      }
    }

    if (field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`"${field.label}" must be true or false`);
    }

    if (field.type === 'script' && typeof value !== 'string') {
      errors.push(`"${field.label}" must be a string of JavaScript`);
    }

    if (field.type === 'select' && field.options?.length) {
      const allowed = field.options.map((option) => option.value);
      if (!allowed.includes(String(value))) {
        errors.push(`"${field.label}" must be one of: ${allowed.join(', ')}`);
      }
    }
  }

  // ── Per-type checks the generic loop cannot express ──────────────────────
  // Each of these is a configuration that saves cleanly and then produces an
  // empty object on every single message.

  if (type === ConverterType.JSON) {
    const rules = config.mappings;
    if (rules !== undefined && !Array.isArray(rules)) {
      errors.push('"Field mappings" must be an array of mapping rules');
    } else if (Array.isArray(rules)) {
      rules.forEach((rule: any, index: number) => {
        const where = `Mapping ${index + 1}`;
        if (!rule || typeof rule !== 'object') {
          errors.push(`${where}: must be an object with source and target`);
          return;
        }
        if (typeof rule.source !== 'string' || !rule.source.trim()) {
          errors.push(`${where}: "source" path is required`);
        }
        if (typeof rule.target !== 'string' || !rule.target.trim()) {
          errors.push(`${where}: "target" key is required`);
        }
        if (rule.scale !== undefined && !Number.isFinite(Number(rule.scale))) {
          errors.push(`${where}: "scale" must be a number`);
        }
        if (rule.offset !== undefined && !Number.isFinite(Number(rule.offset))) {
          errors.push(`${where}: "offset" must be a number`);
        }
        if (
          rule.cast !== undefined &&
          !CAST_OPTIONS.some((option) => option.value === rule.cast)
        ) {
          errors.push(
            `${where}: "cast" must be one of: ${CAST_OPTIONS.map((o) => o.value).join(', ')}`,
          );
        }
      });
    }
  }

  if (type === ConverterType.CODEC) {
    const named = typeof config.codecId === 'string' && config.codecId.trim();
    const byModel =
      typeof config.manufacturer === 'string' &&
      config.manufacturer.trim() &&
      typeof config.model === 'string' &&
      config.model.trim();
    if (!named && !byModel && config.allowAutoDetect !== true) {
      errors.push(
        'Device codec: name a Codec, or a Manufacturer and Model, or turn on ' +
          '"Fall back to auto-detection" — otherwise there is nothing to decode with',
      );
    }
    if (direction === ConverterDirection.DOWNLINK && !named) {
      // CodecRegistryService.encode() takes `{codecId}` and nothing else.
      errors.push(
        'Device codec: a downlink needs an explicit Codec — encoding cannot be ' +
          'auto-detected from a command',
      );
    }
  }

  return errors;
};

/** The directions a type can run, for the create form's direction select. */
export const resolveConverterDirections = (
  type: ConverterType,
): ConverterDirection[] => CONVERTER_CATALOGUE[type]?.directions ?? [];
