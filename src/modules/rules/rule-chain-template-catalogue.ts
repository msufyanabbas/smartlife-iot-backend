import { NodeType } from '@common/enums/index.enum';
import type { RuleChainTemplateDefinition } from './entities/rule-chain-template.entity';
import {
  RULE_NODE_CATALOGUE,
  resolveNodeOutputs,
  validateNodeConfig,
} from './rule-node-catalogue';

export interface TemplateIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Static analysis of a template definition.
 *
 * Mirrors `RulesService.validateGraph()` but against node **indexes** rather
 * than ids, because that is the form a template is stored in. The point is
 * that neither a shipped template nor a saved one can be a graph that writes
 * cleanly and then silently does nothing: an edge on a route its source node
 * cannot emit is never followed, and a node nothing reaches never runs.
 *
 * A pure function rather than a service method so `npm run check:rule-templates`
 * can assert it over the built-ins without a Nest container or a database.
 */
export const validateTemplateDefinition = (
  definition: RuleChainTemplateDefinition | null | undefined,
): TemplateIssue[] => {
  const issues: TemplateIssue[] = [];
  const nodes = Array.isArray(definition?.nodes) ? definition!.nodes : [];

  if (!nodes.length) {
    return [{ severity: 'error', message: 'The template has no nodes' }];
  }

  nodes.forEach((node, index) => {
    const label = node.name || `Node ${index + 1}`;

    if (!RULE_NODE_CATALOGUE[node.type as NodeType]) {
      issues.push({
        severity: 'error',
        message: `${label}: unknown node type "${node.type}"`,
      });
      return;
    }

    for (const message of validateNodeConfig(
      node.type as NodeType,
      node.configuration,
    )) {
      issues.push({ severity: 'error', message: `${label}: ${message}` });
    }

    const routes = new Set(
      resolveNodeOutputs(node.type as NodeType, node.configuration).map(
        (o) => o.route,
      ),
    );

    for (const connection of node.connections ?? []) {
      if (
        !Number.isInteger(connection.targetNodeIndex) ||
        connection.targetNodeIndex < 0 ||
        connection.targetNodeIndex >= nodes.length
      ) {
        issues.push({
          severity: 'error',
          message: `${label}: an edge points at node index ${connection.targetNodeIndex}, which does not exist`,
        });
        continue;
      }

      if (routes.size && !routes.has(connection.connectionType)) {
        issues.push({
          severity: 'warning',
          message: `${label}: nothing is emitted on route "${connection.connectionType}" — this edge is never followed. Available: ${[...routes].join(', ')}`,
        });
      }
    }
  });

  // Reachability, from the declared entry point or the node no edge targets.
  const targeted = new Set<number>();
  nodes.forEach((n) =>
    (n.connections ?? []).forEach((c) => targeted.add(c.targetNodeIndex)),
  );

  const declaredRoot = definition?.rootNodeIndex;
  const rootIndex =
    declaredRoot !== null &&
    declaredRoot !== undefined &&
    declaredRoot >= 0 &&
    declaredRoot < nodes.length
      ? declaredRoot
      : nodes.findIndex((_, i) => !targeted.has(i));

  if (rootIndex === -1) {
    issues.push({
      severity: 'error',
      message:
        'No entry node: every node is the target of an edge, so the engine cannot pick a start',
    });
    return issues;
  }

  const reached = new Set<number>([rootIndex]);
  const queue = [rootIndex];
  while (queue.length) {
    const current = queue.shift()!;
    for (const c of nodes[current]?.connections ?? []) {
      if (!reached.has(c.targetNodeIndex)) {
        reached.add(c.targetNodeIndex);
        queue.push(c.targetNodeIndex);
      }
    }
  }

  nodes.forEach((node, index) => {
    if (!reached.has(index)) {
      issues.push({
        severity: 'warning',
        message: `${node.name || `Node ${index + 1}`}: not reachable from the entry node, so it never runs`,
      });
    }
  });

  return issues;
};

/**
 * The built-in rule chain templates.
 *
 * These are the starting points a tenant sees before they have saved any of
 * their own. They live in code rather than in a seed script so that a deploy
 * can correct a definition: `RuleChainTemplatesService.syncBuiltIns()` upserts
 * them at boot, matching on `slug`.
 *
 * Every definition must be instantiable *without editing* — i.e. it must pass
 * `validateNodeConfig()` for each node and its edges must use routes the node
 * can actually emit. `npm run check:rule-templates` asserts exactly that, so a
 * template cannot ship as a chain that saves cleanly and then does nothing.
 * Where a value genuinely cannot be guessed (an endpoint URL, an email
 * address) the node carries a placeholder and the template lists it in
 * `setupNotes`, which the UI shows before the chain is created.
 *
 * Remember the route names (CLAUDE.md §4f): FILTER emits `true`/`false`,
 * SWITCH emits its own `cases[].outputRoute`, everything else
 * `success`/`failure`. An edge labelled `success` out of a filter is never
 * followed.
 */
export interface BuiltInRuleChainTemplate {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  definition: RuleChainTemplateDefinition & { setupNotes?: string[] };
}

const COL = (index: number) => 80 + index * 260;

export const BUILT_IN_RULE_CHAIN_TEMPLATES: BuiltInRuleChainTemplate[] = [
  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'telemetry-threshold-alarm',
    name: 'Threshold alarm',
    description:
      'Raise an alarm when a reading crosses a limit. The filter is set to temperature above 30 — change the key and value to watch something else.',
    category: 'Alarms',
    icon: 'Thermometer',
    definition: {
      formatVersion: 1,
      description: 'Raise an alarm when a reading crosses a limit.',
      configuration: { messageTypes: ['TELEMETRY'] },
      rootNodeIndex: 0,
      setupNotes: [
        'Open the filter node and set the key and threshold you want to watch.',
        'The alarm type and severity on the action node decide what appears on the alarms page.',
      ],
      nodes: [
        {
          name: 'Over threshold?',
          type: NodeType.FILTER,
          position: { x: COL(0), y: 160 },
          configuration: {
            filterType: 'condition',
            messageTypes: ['TELEMETRY'],
            condition: {
              operator: 'AND',
              conditions: [
                { key: 'temperature', operator: 'GREATER_THAN', value: 30 },
              ],
            },
          },
          connections: [
            { targetNodeIndex: 1, connectionType: 'true', label: 'over limit' },
          ],
        },
        {
          name: 'Raise alarm',
          type: NodeType.ACTION,
          position: { x: COL(1), y: 160 },
          configuration: {
            actionType: 'create_alarm',
            alarmType: 'High temperature',
            severity: 'warning',
            description: 'Temperature went above the configured threshold.',
          },
          connections: [],
        },
      ],
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'enrich-convert-store',
    name: 'Enrich, convert and store',
    description:
      'The standard ingestion path: attach the device’s attributes to the message, normalise its units, then persist it as telemetry.',
    category: 'Data Processing',
    icon: 'Database',
    definition: {
      formatVersion: 1,
      description: 'Attach device attributes, normalise units, then persist.',
      configuration: { messageTypes: ['TELEMETRY'] },
      rootNodeIndex: 0,
      setupNotes: [
        'List the device attributes you want attached on the enrichment node.',
        'The transformation node is empty by default — add key renames or unit conversions if your devices need them.',
      ],
      nodes: [
        {
          name: 'Add device attributes',
          type: NodeType.ENRICHMENT,
          position: { x: COL(0), y: 160 },
          configuration: { deviceAttributes: ['location', 'floor'] },
          connections: [{ targetNodeIndex: 1, connectionType: 'success' }],
        },
        {
          name: 'Normalise units',
          type: NodeType.TRANSFORMATION,
          position: { x: COL(1), y: 160 },
          configuration: { dataKeyMapping: {}, conversions: [] },
          connections: [{ targetNodeIndex: 2, connectionType: 'success' }],
        },
        {
          name: 'Save telemetry',
          type: NodeType.ACTION,
          position: { x: COL(2), y: 160 },
          configuration: { actionType: 'save_telemetry' },
          connections: [],
        },
      ],
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'severity-routing',
    name: 'Severity routing',
    description:
      'Grade one reading into three bands with a switch and raise a differently-severe alarm for each. Shows how a switch’s named routes drive the branches.',
    category: 'Alarms',
    icon: 'GitBranch',
    definition: {
      formatVersion: 1,
      description: 'Grade a reading into bands and alarm accordingly.',
      configuration: { messageTypes: ['TELEMETRY'] },
      rootNodeIndex: 0,
      setupNotes: [
        'Each case names the route its edge uses — rename a case and you must re-draw its edge.',
        'Cases are evaluated top to bottom; the first match wins.',
      ],
      nodes: [
        {
          name: 'Grade the reading',
          type: NodeType.SWITCH,
          position: { x: COL(0), y: 220 },
          configuration: {
            cases: [
              {
                key: 'temperature',
                operator: 'GREATER_THAN',
                value: 50,
                outputRoute: 'critical',
              },
              {
                key: 'temperature',
                operator: 'GREATER_THAN',
                value: 35,
                outputRoute: 'warning',
              },
            ],
            defaultRoute: 'normal',
          },
          connections: [
            { targetNodeIndex: 1, connectionType: 'critical' },
            { targetNodeIndex: 2, connectionType: 'warning' },
            { targetNodeIndex: 3, connectionType: 'normal' },
          ],
        },
        {
          name: 'Critical alarm',
          type: NodeType.ACTION,
          position: { x: COL(1), y: 80 },
          configuration: {
            actionType: 'create_alarm',
            alarmType: 'Critical temperature',
            severity: 'critical',
          },
          connections: [],
        },
        {
          name: 'Warning alarm',
          type: NodeType.ACTION,
          position: { x: COL(1), y: 220 },
          configuration: {
            actionType: 'create_alarm',
            alarmType: 'Elevated temperature',
            severity: 'warning',
          },
          connections: [],
        },
        {
          name: 'Store normal reading',
          type: NodeType.ACTION,
          position: { x: COL(1), y: 360 },
          configuration: { actionType: 'save_telemetry' },
          connections: [],
        },
      ],
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'device-offline-notification',
    name: 'Device offline notification',
    description:
      'Watch device-status messages and email someone when a device drops offline.',
    category: 'Notifications',
    icon: 'MailWarning',
    definition: {
      formatVersion: 1,
      description: 'Email a recipient when a device goes offline.',
      configuration: { messageTypes: ['DEVICE_STATUS'] },
      rootNodeIndex: 0,
      setupNotes: [
        'Set the recipient on the email action before enabling the chain — it ships without one.',
        'Email delivery needs SMTP configured on the server (SMTP_HOST and friends).',
      ],
      nodes: [
        {
          name: 'Went offline?',
          type: NodeType.FILTER,
          position: { x: COL(0), y: 160 },
          configuration: {
            filterType: 'condition',
            messageTypes: ['DEVICE_STATUS'],
            condition: {
              operator: 'AND',
              conditions: [
                { key: 'status', operator: 'EQUALS', value: 'offline' },
              ],
            },
          },
          connections: [
            { targetNodeIndex: 1, connectionType: 'true', label: 'offline' },
          ],
        },
        {
          name: 'Email the operator',
          type: NodeType.ACTION,
          position: { x: COL(1), y: 160 },
          configuration: {
            actionType: 'send_email',
            actionConfig: {
              to: '',
              subject: 'Device offline',
              body: 'A device stopped reporting. Check the device page for details.',
            },
          },
          connections: [],
        },
      ],
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'forward-to-external-api',
    name: 'Forward to an external API',
    description:
      'Filter the traffic you care about and POST it to an HTTP endpoint of your own. Useful for pushing a subset of readings into another system.',
    category: 'Connectivity',
    icon: 'Webhook',
    definition: {
      formatVersion: 1,
      description: 'POST selected messages to an external HTTP endpoint.',
      configuration: { messageTypes: ['TELEMETRY'] },
      rootNodeIndex: 0,
      setupNotes: [
        'Replace the placeholder URL on the external node with your own endpoint.',
        'Add any auth header the endpoint needs — the node sends none by default.',
        'Testing this chain performs the call for real; there is no sandbox.',
      ],
      nodes: [
        {
          name: 'Has a reading?',
          type: NodeType.FILTER,
          position: { x: COL(0), y: 160 },
          configuration: {
            filterType: 'condition',
            condition: {
              operator: 'AND',
              conditions: [{ key: 'temperature', operator: 'EXISTS' }],
            },
          },
          connections: [{ targetNodeIndex: 1, connectionType: 'true' }],
        },
        {
          name: 'POST to endpoint',
          type: NodeType.EXTERNAL,
          position: { x: COL(1), y: 160 },
          configuration: {
            url: 'https://example.invalid/replace-me',
            method: 'POST',
            includeMessageAsBody: true,
            headers: {},
          },
          connections: [],
        },
      ],
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  {
    slug: 'passthrough-starter',
    name: 'Empty starter',
    description:
      'A single save-telemetry node and nothing else. Start here when you want to build a chain from scratch but would rather not begin with a blank canvas.',
    category: 'General',
    icon: 'Workflow',
    definition: {
      formatVersion: 1,
      description: 'A one-node chain to build on.',
      configuration: {},
      rootNodeIndex: 0,
      nodes: [
        {
          name: 'Save telemetry',
          type: NodeType.ACTION,
          position: { x: COL(0), y: 160 },
          configuration: { actionType: 'save_telemetry' },
          connections: [],
        },
      ],
    },
  },
];

export const BUILT_IN_TEMPLATE_CATEGORIES = Array.from(
  new Set(BUILT_IN_RULE_CHAIN_TEMPLATES.map((t) => t.category)),
).sort();
