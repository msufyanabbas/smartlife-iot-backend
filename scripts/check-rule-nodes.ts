/**
 * Guards the rule-node catalogue against the engine it describes.
 *
 * The catalogue drives both the editor palette and the node config form, so a
 * drift between it and the processors is invisible until a node silently does
 * nothing at runtime.
 */
import { NodeType } from '../src/common/enums/node.enum';
import {
  RULE_NODE_CATALOGUE,
  listRuleNodeCatalogue,
  resolveNodeOutputs,
  validateNodeConfig,
} from '../src/modules/rules/rule-node-catalogue';

let bad = 0;
const fail = (m: string) => {
  console.log('FAIL:', m);
  bad++;
};

// 1. Every NodeType has a manifest and vice versa.
for (const t of Object.values(NodeType)) {
  if (!RULE_NODE_CATALOGUE[t]) fail(`no manifest for NodeType.${t}`);
}
for (const [key, m] of Object.entries(RULE_NODE_CATALOGUE)) {
  if (m.type !== key) fail(`manifest ${key} declares type ${m.type}`);
}

// 2. listRuleNodeCatalogue() omits nothing — a type missing from the order
//    array would simply never appear in the palette.
const listed = new Set(listRuleNodeCatalogue().map((m) => m.type));
for (const t of Object.values(NodeType)) {
  if (!listed.has(t)) fail(`NodeType.${t} has a manifest but is not in the palette order`);
}

// 3. Field keys unique; selects have options; showIf targets exist.
for (const m of listRuleNodeCatalogue()) {
  const keys = m.fields.map((f) => f.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) fail(`${m.type}: duplicate field keys ${[...new Set(dupes)]}`);
  for (const f of m.fields) {
    if (f.type === 'select' && !f.options?.length) {
      fail(`${m.type}.${f.key}: select with no options`);
    }
    if (f.showIf && !keys.includes(f.showIf.key)) {
      fail(`${m.type}.${f.key}: showIf targets unknown key ${f.showIf.key}`);
    }
  }
}

// 4. Outputs: a fixed-output node must declare at least one route, or nothing
//    can ever leave it.
for (const m of listRuleNodeCatalogue()) {
  if (!m.dynamicOutputs && m.outputs.length === 0) {
    fail(`${m.type}: no outputs and not dynamic — edges out of it are impossible`);
  }
  if (m.dynamicOutputs && m.outputs.length > 0) {
    fail(`${m.type}: dynamicOutputs with a fixed outputs list is ambiguous`);
  }
}

// 5. A dynamic node resolves its routes from config.
const switchRoutes = resolveNodeOutputs(NodeType.SWITCH, {
  cases: [{ key: 'temperature', operator: 'GREATER_THAN', value: 30, outputRoute: 'hot' }],
  defaultRoute: 'cold',
}).map((o) => o.route);
if (!switchRoutes.includes('hot') || !switchRoutes.includes('cold')) {
  fail(`SWITCH route resolution lost a route: got ${switchRoutes}`);
}

// 6. Required fields actually fail on an empty config.
for (const m of listRuleNodeCatalogue()) {
  const required = m.fields.filter((f) => f.required && !f.showIf).length;
  const errors = validateNodeConfig(m.type, {});
  if (errors.length < required) {
    fail(`${m.type}: ${required} required field(s) but only ${errors.length} error(s) on an empty config`);
  }
}

console.log(`\n${listRuleNodeCatalogue().length} node types checked; ${bad} problem(s).`);
console.log(
  '\nPalette:\n  ' +
    listRuleNodeCatalogue()
      .map(
        (m) =>
          `${m.type.padEnd(15)} ${m.category.padEnd(15)} outputs: ${
            m.dynamicOutputs ? '(from config)' : m.outputs.map((o) => o.route).join('/')
          }`,
      )
      .join('\n  '),
);
process.exit(bad ? 1 : 0);
