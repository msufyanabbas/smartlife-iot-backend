/**
 * Asserts that every built-in rule chain template is instantiable as shipped.
 *
 *   npm run check:rule-templates
 *
 * Why this needs a check rather than a glance: a template is a graph, and the
 * two ways a graph silently fails are both invisible by inspection.
 *
 *   1. An edge on a route its source node cannot emit is simply never
 *      followed — the chain runs, reports success, and the branch behind that
 *      edge never executes. FILTER emits true/false, SWITCH emits its own
 *      case routes, everything else success/failure; it is very easy to write
 *      `success` out of a filter.
 *   2. A node missing a required field saves cleanly and then fails at
 *      runtime, inside whatever message happened to reach it.
 *
 * A built-in that ships either way is worse than no template at all: the user
 * assumes the platform's own starting point works, so they debug their data.
 */
import {
  BUILT_IN_RULE_CHAIN_TEMPLATES,
  validateTemplateDefinition,
} from '../src/modules/rules/rule-chain-template-catalogue';
import { RULE_NODE_CATALOGUE } from '../src/modules/rules/rule-node-catalogue';
import { NodeType } from '../src/common/enums/index.enum';

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error(`  ✗ ${message}`);
};

console.log(
  `Checking ${BUILT_IN_RULE_CHAIN_TEMPLATES.length} built-in rule chain templates\n`,
);

const slugs = new Set<string>();

for (const template of BUILT_IN_RULE_CHAIN_TEMPLATES) {
  const nodes = template.definition.nodes ?? [];
  console.log(`${template.name}  [${template.slug}]  ${nodes.length} nodes`);

  // The boot-time upsert matches on slug, so a duplicate would make two
  // built-ins overwrite each other on every start.
  if (slugs.has(template.slug)) fail(`duplicate slug "${template.slug}"`);
  slugs.add(template.slug);

  if (!template.name?.trim()) fail('missing name');
  if (!template.description?.trim()) fail('missing description');
  if (!template.category?.trim()) fail('missing category');
  if (!template.icon?.trim()) fail('missing icon');

  for (const node of nodes) {
    if (!RULE_NODE_CATALOGUE[node.type as NodeType]) {
      fail(`node "${node.name}" has unknown type "${node.type}"`);
    }
  }

  const issues = validateTemplateDefinition(template.definition);

  // Errors are disqualifying. Warnings are too, for a *built-in*: an
  // unreachable node or a dead edge in platform content is a mistake, not a
  // choice a tenant made.
  for (const issue of issues) {
    fail(`${issue.severity}: ${issue.message}`);
  }

  if (!issues.length) console.log('  ✓ valid, reachable, routes line up');

  // A template whose nodes all need editing before use is a worse starting
  // point than a blank canvas, so the notes are a contract: if a node carries
  // a placeholder, say so.
  const placeholders = JSON.stringify(template.definition).match(
    /example\.invalid|replace-me/g,
  );
  if (placeholders?.length && !template.definition.setupNotes?.length) {
    fail('carries placeholder values but lists no setupNotes');
  }
}

console.log(
  failures
    ? `\nFAIL — ${failures} problem(s) in the built-in templates`
    : '\nPASS — every built-in template is valid and instantiable as shipped',
);
process.exit(failures ? 1 : 0);
