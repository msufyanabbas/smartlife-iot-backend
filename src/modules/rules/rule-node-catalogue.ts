import { NodeType } from '@common/enums/index.enum';
import type { ConditionOperator } from '@modules/nodes/condition.util';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The node palette, declared once on the server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rule-chain editor renders its palette AND each node's configuration form
 * from this table, the same way the Integration Centre works. The reason is the
 * same: a node's configuration keys are read by its processor
 * (`modules/nodes/*-node.ts`), and a form hand-written in the frontend drifts
 * from them silently — a typo'd key saves cleanly and the node then behaves as
 * if unconfigured, because `configuration` is a free jsonb column.
 *
 * Every `fields[].key` below was taken from the processor that reads it. If you
 * add a key to a processor, add it here; `npm run check:rule-nodes` fails if a
 * declared type has no processor.
 *
 * `outputs` is the other half the editor needs: it is the set of route labels a
 * node can emit, which is exactly what `RuleEngineService.resolveNextNode()`
 * matches against `connection.connectionType`. Without it the editor cannot
 * know that a FILTER has `true`/`false` edges while an ACTION has
 * `success`/`failure`, and a SWITCH's routes are whatever its cases name.
 */

export type RuleNodeFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'json'
  | 'script'
  | 'conditions'
  | 'cases'
  | 'keyvalue'
  | 'chain';

export interface RuleNodeFieldOption {
  value: string;
  label: string;
}

export interface RuleNodeConfigField {
  key: string;
  label: string;
  type: RuleNodeFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: unknown;
  options?: RuleNodeFieldOption[];
  group?: string;
  /** Render only when another field holds one of these values. */
  showIf?: { key: string; equals: Array<string | number | boolean> };
}

export interface RuleNodeOutput {
  /** The literal written to `connection.connectionType`. */
  route: string;
  label: string;
  /** Guidance only — the editor colours the edge by this. */
  tone: 'success' | 'failure' | 'neutral';
}

export interface RuleNodeManifest {
  type: NodeType;
  label: string;
  category: 'filter' | 'enrichment' | 'transformation' | 'action' | 'flow';
  description: string;
  /** lucide-react icon name. */
  icon: string;
  /**
   * Outputs this node can emit. An empty array means the node names its own
   * routes at configuration time (SWITCH), and the editor should read them from
   * the saved config instead.
   */
  outputs: RuleNodeOutput[];
  /** True when `outputs` is derived from configuration rather than fixed. */
  dynamicOutputs?: boolean;
  fields: RuleNodeConfigField[];
}

/** Operators shared by FILTER conditions and SWITCH cases. */
export const CONDITION_OPERATORS: Array<{
  value: ConditionOperator;
  label: string;
}> = [
  { value: 'EQUALS', label: 'equals' },
  { value: 'NOT_EQUALS', label: 'does not equal' },
  { value: 'GREATER_THAN', label: 'is greater than' },
  { value: 'GREATER_THAN_OR_EQUAL', label: 'is greater than or equal to' },
  { value: 'LESS_THAN', label: 'is less than' },
  { value: 'LESS_THAN_OR_EQUAL', label: 'is less than or equal to' },
  { value: 'CONTAINS', label: 'contains' },
  { value: 'NOT_CONTAINS', label: 'does not contain' },
  { value: 'EXISTS', label: 'exists' },
  { value: 'NOT_EXISTS', label: 'does not exist' },
  { value: 'IN', label: 'is one of' },
  { value: 'NOT_IN', label: 'is not one of' },
];

const MESSAGE_TYPE_OPTIONS: RuleNodeFieldOption[] = [
  { value: 'TELEMETRY', label: 'Telemetry' },
  { value: 'ATTRIBUTE', label: 'Attribute update' },
  { value: 'ALARM', label: 'Alarm' },
  { value: 'DEVICE_STATUS', label: 'Device status' },
  { value: 'RPC_REQUEST', label: 'RPC request' },
];

const ORIGINATOR_TYPE_OPTIONS: RuleNodeFieldOption[] = [
  { value: 'DEVICE', label: 'Device' },
  { value: 'ASSET', label: 'Asset' },
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'TENANT', label: 'Tenant' },
];

const SUCCESS_FAILURE: RuleNodeOutput[] = [
  { route: 'success', label: 'Success', tone: 'success' },
  { route: 'failure', label: 'Failure', tone: 'failure' },
];

const timeoutField = (): RuleNodeConfigField => ({
  key: 'timeout',
  label: 'Timeout (ms)',
  type: 'number',
  default: 5000,
  group: 'Advanced',
  help: 'How long to wait before the node fails.',
});

export const RULE_NODE_CATALOGUE: Record<NodeType, RuleNodeManifest> = {
  // ── Filter ────────────────────────────────────────────────────────────────
  [NodeType.FILTER]: {
    type: NodeType.FILTER,
    label: 'Filter',
    category: 'filter',
    description:
      'Let a message through only when it matches. Routes on true/false, so both branches can continue the chain.',
    icon: 'Filter',
    // FilterNodeProcessor returns route 'true' / 'false', NOT success/failure.
    // Getting this wrong is why a filter's "no" branch appears never to fire.
    outputs: [
      { route: 'true', label: 'Matched', tone: 'success' },
      { route: 'false', label: 'Did not match', tone: 'failure' },
    ],
    fields: [
      {
        key: 'filterType',
        label: 'Filter on',
        type: 'select',
        default: 'condition',
        options: [
          { value: 'condition', label: 'A condition on the message data' },
          { value: 'script', label: 'A script' },
        ],
      },
      {
        key: 'messageTypes',
        label: 'Message types',
        type: 'multiselect',
        options: MESSAGE_TYPE_OPTIONS,
        group: 'Pre-filters',
        help: 'Leave empty to accept every type. Checked before the condition below.',
      },
      {
        key: 'originatorTypes',
        label: 'Originator types',
        type: 'multiselect',
        options: ORIGINATOR_TYPE_OPTIONS,
        group: 'Pre-filters',
        help: 'Leave empty to accept any originator.',
      },
      {
        key: 'condition',
        label: 'Condition',
        type: 'conditions',
        showIf: { key: 'filterType', equals: ['condition'] },
        help: 'Keys resolve against the message data, and may use dot notation (location.city).',
      },
      {
        key: 'script',
        label: 'Script',
        type: 'script',
        showIf: { key: 'filterType', equals: ['script'] },
        placeholder: 'return msg.temperature > 30;',
        help: 'Must return a boolean. `msg` is the message data.',
      },
    ],
  },

  // ── Switch ────────────────────────────────────────────────────────────────
  [NodeType.SWITCH]: {
    type: NodeType.SWITCH,
    label: 'Switch',
    category: 'filter',
    description:
      'Send a message down one of several named routes. The first matching case wins.',
    icon: 'GitBranch',
    outputs: [],
    // The routes are whatever the cases name, so the editor reads them from
    // `cases[].outputRoute` plus `defaultRoute` rather than from this table.
    dynamicOutputs: true,
    fields: [
      {
        key: 'cases',
        label: 'Cases',
        type: 'cases',
        required: true,
        help: 'Evaluated top to bottom. Each case names the route its edge will use.',
      },
      {
        key: 'defaultRoute',
        label: 'Default route',
        type: 'text',
        default: 'default',
        help: 'Used when no case matches. Leave as "default" unless you need a specific name.',
      },
    ],
  },

  // ── Enrichment ────────────────────────────────────────────────────────────
  [NodeType.ENRICHMENT]: {
    type: NodeType.ENRICHMENT,
    label: 'Enrichment',
    category: 'enrichment',
    description:
      'Add context to the message — device or customer attributes, related entities, or fixed fields.',
    icon: 'PlusCircle',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'deviceAttributes',
        label: 'Device attributes',
        type: 'multiselect',
        options: [],
        help: 'Attribute keys to copy onto the message. Free text — one per entry.',
      },
      {
        key: 'customerAttributes',
        label: 'Customer attributes',
        type: 'multiselect',
        options: [],
        help: 'Attribute keys from the owning customer.',
      },
      {
        key: 'relatedEntities',
        label: 'Related entities',
        type: 'multiselect',
        options: ORIGINATOR_TYPE_OPTIONS,
        group: 'Advanced',
      },
      {
        key: 'customFields',
        label: 'Fixed fields',
        type: 'keyvalue',
        help: 'Literal key/value pairs merged into the message.',
      },
    ],
  },

  // ── Transformation ────────────────────────────────────────────────────────
  [NodeType.TRANSFORMATION]: {
    type: NodeType.TRANSFORMATION,
    label: 'Transformation',
    category: 'transformation',
    description:
      'Rename keys, convert units, or rewrite the message with a script.',
    icon: 'Shuffle',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'dataKeyMapping',
        label: 'Rename keys',
        type: 'keyvalue',
        help: 'Left is the incoming key, right is the new name — e.g. temp → temperature.',
      },
      {
        key: 'conversions',
        label: 'Unit conversions',
        type: 'json',
        group: 'Advanced',
        placeholder:
          '{ "temperature": { "multiply": 0.1 }, "pressure": { "add": -1013 } }',
        help: 'Per-key numeric adjustments applied after renaming.',
      },
      {
        key: 'script',
        label: 'Script',
        type: 'script',
        group: 'Advanced',
        placeholder: 'msg.fahrenheit = msg.temperature * 9 / 5 + 32;\nreturn msg;',
        help: 'Runs last. Must return the message. `msg` is the message data.',
      },
    ],
  },

  // ── Action ────────────────────────────────────────────────────────────────
  [NodeType.ACTION]: {
    type: NodeType.ACTION,
    label: 'Action',
    category: 'action',
    description:
      'Do something with the message: store it, raise an alarm, send an email, call an API or publish to MQTT.',
    icon: 'Zap',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'actionType',
        label: 'Action',
        type: 'select',
        required: true,
        default: 'save_telemetry',
        // These six strings are the exact cases in ActionNodeProcessor's switch.
        // Anything else falls through and the node does nothing.
        options: [
          { value: 'save_telemetry', label: 'Save as telemetry' },
          { value: 'save_attributes', label: 'Save as attributes' },
          { value: 'create_alarm', label: 'Create an alarm' },
          { value: 'send_email', label: 'Send an email' },
          { value: 'rest_api_call', label: 'Call a REST API' },
          { value: 'mqtt_publish', label: 'Publish to MQTT' },
        ],
      },

      // save_attributes
      {
        key: 'scope',
        label: 'Attribute scope',
        type: 'select',
        default: 'SERVER_SCOPE',
        options: [
          { value: 'SERVER_SCOPE', label: 'Server' },
          { value: 'SHARED_SCOPE', label: 'Shared' },
          { value: 'CLIENT_SCOPE', label: 'Client' },
        ],
        showIf: { key: 'actionType', equals: ['save_attributes'] },
      },
      {
        key: 'attributes',
        label: 'Attributes',
        type: 'keyvalue',
        showIf: { key: 'actionType', equals: ['save_attributes'] },
        help: 'Leave empty to save every key in the message.',
      },

      // create_alarm
      {
        key: 'alarmType',
        label: 'Alarm type',
        type: 'text',
        required: true,
        placeholder: 'High temperature',
        showIf: { key: 'actionType', equals: ['create_alarm'] },
      },
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        default: 'warning',
        options: [
          { value: 'critical', label: 'Critical' },
          { value: 'error', label: 'Error' },
          { value: 'warning', label: 'Warning' },
          { value: 'info', label: 'Info' },
        ],
        showIf: { key: 'actionType', equals: ['create_alarm'] },
      },
      {
        key: 'description',
        label: 'Alarm description',
        type: 'textarea',
        showIf: { key: 'actionType', equals: ['create_alarm'] },
      },

      // send_email
      {
        key: 'actionConfig',
        label: 'Email settings',
        type: 'json',
        showIf: { key: 'actionType', equals: ['send_email'] },
        placeholder:
          '{ "recipients": ["ops@example.com"], "template": "Temperature is {{temperature}}" }',
        help: 'recipients[] and template. The template may reference message keys.',
      },

      // rest_api_call
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'https://example.com/hook',
        showIf: { key: 'actionType', equals: ['rest_api_call'] },
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'POST',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'GET', label: 'GET' },
        ],
        showIf: { key: 'actionType', equals: ['rest_api_call'] },
      },
      {
        key: 'headers',
        label: 'Headers',
        type: 'keyvalue',
        showIf: { key: 'actionType', equals: ['rest_api_call'] },
      },
      {
        key: 'body',
        label: 'Body',
        type: 'json',
        showIf: { key: 'actionType', equals: ['rest_api_call'] },
        help: 'Leave empty to send the message as-is.',
      },

      // mqtt_publish
      {
        key: 'topic',
        label: 'Topic',
        type: 'text',
        required: true,
        placeholder: 'smartlife/{{deviceId}}/alerts',
        showIf: { key: 'actionType', equals: ['mqtt_publish'] },
        help: '{{deviceId}}, {{deviceKey}} and {{tenantId}} are substituted.',
      },
      {
        key: 'payload',
        label: 'Payload',
        type: 'json',
        showIf: { key: 'actionType', equals: ['mqtt_publish'] },
        help: 'Leave empty to publish the message as-is.',
      },

      timeoutField(),
    ],
  },

  // ── Script ────────────────────────────────────────────────────────────────
  [NodeType.SCRIPT]: {
    type: NodeType.SCRIPT,
    label: 'Script',
    category: 'transformation',
    description:
      'Run JavaScript against the message in a sandbox. Use a saved script from the library, or write one inline.',
    icon: 'Code',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'scriptId',
        label: 'Saved script',
        type: 'text',
        group: 'Library',
        help: 'Id of a script from the Scripts library. Takes precedence over the inline script below.',
      },
      {
        key: 'script',
        label: 'Inline script',
        type: 'script',
        placeholder: 'if (msg.temperature > 30) { msg.hot = true; }\nreturn msg;',
        help: 'Runs in vm2. `msg` is the message data; return the message to pass it on.',
      },
      timeoutField(),
    ],
  },

  // ── External ──────────────────────────────────────────────────────────────
  [NodeType.EXTERNAL]: {
    type: NodeType.EXTERNAL,
    label: 'External HTTP',
    category: 'action',
    description:
      'Call an outside HTTP endpoint and continue with its response.',
    icon: 'Globe',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.example.com/enrich',
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'POST',
        options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
        ],
      },
      { key: 'headers', label: 'Headers', type: 'keyvalue' },
      {
        key: 'includeMessageAsBody',
        label: 'Send the message as the body',
        type: 'boolean',
        default: true,
      },
      timeoutField(),
    ],
  },

  // ── Flow ──────────────────────────────────────────────────────────────────
  [NodeType.FLOW]: {
    type: NodeType.FLOW,
    label: 'Sub-chain',
    category: 'flow',
    description:
      'Hand the message to another rule chain and continue with its result.',
    icon: 'CornerDownRight',
    outputs: SUCCESS_FAILURE,
    fields: [
      {
        key: 'targetChainId',
        label: 'Rule chain',
        type: 'chain',
        required: true,
        help: 'The chain to invoke. Pointing a chain at itself will hit the 50-hop limit.',
      },
    ],
  },
};

/** Palette order: the types you reach for first, first. */
export const listRuleNodeCatalogue = (): RuleNodeManifest[] => {
  const order: NodeType[] = [
    NodeType.FILTER,
    NodeType.SWITCH,
    NodeType.ENRICHMENT,
    NodeType.TRANSFORMATION,
    NodeType.SCRIPT,
    NodeType.ACTION,
    NodeType.EXTERNAL,
    NodeType.FLOW,
  ];
  return order.map((t) => RULE_NODE_CATALOGUE[t]).filter(Boolean);
};

/**
 * Validate a node's configuration against its manifest.
 *
 * Returns messages rather than throwing, so the caller reports every problem in
 * one response instead of one per round trip. Only declared fields are checked;
 * extra keys pass, because `configuration` is a free jsonb column and existing
 * rows carry keys the catalogue never declared.
 */
export const validateNodeConfig = (
  type: NodeType,
  configuration: Record<string, unknown> | undefined | null,
): string[] => {
  const manifest = RULE_NODE_CATALOGUE[type];
  if (!manifest) return [`Unknown node type "${type}"`];

  const config = configuration ?? {};
  const errors: string[] = [];

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
    }
  }

  return errors;
};

/**
 * The route labels a node can actually emit, including the dynamic ones.
 *
 * The editor needs this to decide which output ports to draw on a SWITCH, and
 * the metadata save uses it to reject an edge whose `connectionType` no node
 * could ever produce — an edge the engine would silently never follow.
 */
export const resolveNodeOutputs = (
  type: NodeType,
  configuration?: Record<string, any> | null,
): RuleNodeOutput[] => {
  const manifest = RULE_NODE_CATALOGUE[type];
  if (!manifest) return [];
  if (!manifest.dynamicOutputs) return manifest.outputs;

  const config = configuration ?? {};
  const routes = new Map<string, RuleNodeOutput>();

  for (const entry of Array.isArray(config.cases) ? config.cases : []) {
    const route = entry?.outputRoute;
    if (typeof route === 'string' && route.trim()) {
      routes.set(route, { route, label: route, tone: 'success' });
    }
  }

  const fallback = String(config.defaultRoute ?? 'default');
  if (fallback.trim()) {
    routes.set(fallback, {
      route: fallback,
      label: `${fallback} (no case matched)`,
      tone: 'neutral',
    });
  }

  return Array.from(routes.values());
};
