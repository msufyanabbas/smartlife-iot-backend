/**
 * Verifies the rule chain template flow against a real PostgreSQL database.
 *
 *   createdb tmplcheck && npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-rule-chain-templates.ts tmplcheck
 *
 * Why this and not the HTTP e2e script: booting the application needs a
 * reachable Kafka broker (CLAUDE.md §11), so the services are wired by hand
 * here. Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, real transaction in `saveMetadata`.
 *
 * What it proves, in order:
 *   1. The entity initialises. A nullable column whose property is a union
 *      takes the whole app down at `DataSource.initialize` if it has no
 *      explicit `type`; this catches that before a deploy does.
 *   2. The built-in catalogue upserts, and upserting twice does not duplicate.
 *   3. A tenant sees built-ins plus its own, and nobody sees another tenant's.
 *   4. **Instantiate actually builds the graph**: the right number of nodes,
 *      with index-based edges rewritten to real node ids.
 *   5. Usage is counted.
 *   6. A built-in is read-only (403), and an invalid definition is rejected
 *      with field-level errors.
 *   7. Capturing an existing chain as a template round-trips.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { RuleChainTemplate } from '../src/modules/rules/entities/rule-chain-template.entity';
import { RuleChain } from '../src/modules/rules/entities/rule-chain.entity';
import { Node } from '../src/modules/nodes/entities/node.entity';
import { RulesService } from '../src/modules/rules/rules.service';
import { RuleChainTemplatesService } from '../src/modules/rules/rule-chain-templates.service';
import { BUILT_IN_RULE_CHAIN_TEMPLATES } from '../src/modules/rules/rule-chain-template-catalogue';
import { RuleEngineService } from '../src/modules/rules/rule-engine.service';
import { SwitchNodeProcessor } from '../src/modules/nodes/processors/switch-node';

const database = process.argv[2] ?? 'tmplcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) => console.log(`\n── ${title} ─────────────`);

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER = randomUUID();

(async () => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });

  section('1. Schema');
  await dataSource.initialize();
  check('DataSource initialises with RuleChainTemplate registered', true);

  const templateRepo: Repository<RuleChainTemplate> =
    dataSource.getRepository(RuleChainTemplate);
  const chainRepo: Repository<RuleChain> = dataSource.getRepository(RuleChain);
  const nodeRepo: Repository<Node> = dataSource.getRepository(Node);

  // Clean slate for repeated runs.
  await nodeRepo.query('DELETE FROM nodes');
  await chainRepo.query('DELETE FROM rule_chains');
  await templateRepo.query('DELETE FROM rule_chain_templates');
  await templateRepo.query('DELETE FROM users WHERE id = $1', [USER]);
  await templateRepo.query('DELETE FROM tenants WHERE id = ANY($1)', [
    [TENANT_A, TENANT_B],
  ]);

  // Real tenant and user rows, because `rule_chain_templates.tenantId` and
  // `rule_chains.tenantId`/`userId` carry foreign keys — the entity declares
  // @ManyToOne against them, so the schema gets a real constraint whether a
  // hand-written migration mentions it or not. Fixtures with invented uuids
  // fail the insert, which is how that was found.
  for (const [index, id] of [TENANT_A, TENANT_B].entries()) {
    await templateRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [id, `Fixture tenant ${index + 1} ${id.slice(0, 8)}`, `t${index}-${id.slice(0, 8)}@example.invalid`],
    );
  }
  await templateRepo.query(
    `INSERT INTO users (id, email, password, name, role, "tenantId")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      USER,
      `fixture-${USER.slice(0, 8)}@example.invalid`,
      'not-a-real-hash',
      'Fixture admin',
      'tenant_admin',
      TENANT_A,
    ],
  );

  // Quota checks are skipped for tenants with no subscription row, which is
  // exactly this fixture's situation — so a stub that reports "no limits" is
  // the same answer the real service would give.
  const subscriptionsStub: any = {
    canTenantPerformAction: async () => true,
    incrementTenantUsage: async () => undefined,
    decrementTenantUsage: async () => undefined,
  };

  const rulesService = new RulesService(
    chainRepo,
    nodeRepo,
    subscriptionsStub,
    dataSource,
  );
  const templatesService = new RuleChainTemplatesService(
    templateRepo,
    rulesService,
  );

  section('2. Built-in catalogue');
  const first = await templatesService.syncBuiltIns();
  check(
    `${BUILT_IN_RULE_CHAIN_TEMPLATES.length} built-ins created`,
    first.created === BUILT_IN_RULE_CHAIN_TEMPLATES.length,
    first,
  );

  const second = await templatesService.syncBuiltIns();
  check(
    'a second sync updates rather than duplicates',
    second.created === 0 &&
      second.updated === BUILT_IN_RULE_CHAIN_TEMPLATES.length,
    second,
  );
  check(
    'row count is still the catalogue size',
    (await templateRepo.count()) === BUILT_IN_RULE_CHAIN_TEMPLATES.length,
  );

  const allValid = (
    await Promise.all(
      (await templateRepo.find()).map(async (row) => {
        const issues = templatesService.validateDefinition(row.definition);
        if (issues.length) console.error(`      ${row.slug}:`, issues);
        return issues.length === 0;
      }),
    )
  ).every(Boolean);
  check('every stored built-in validates clean', allValid);

  section('3. Scoping');
  const listA = await templatesService.findAll(TENANT_A, { page: 1, limit: 50 } as any);
  check(
    'tenant A sees the built-ins',
    listA.meta.totalItems === BUILT_IN_RULE_CHAIN_TEMPLATES.length,
    listA.meta,
  );

  const own = await templatesService.create(TENANT_A, USER, {
    name: 'Tenant A private template',
    category: 'Internal',
    definition: {
      nodes: [
        {
          name: 'Save it',
          type: 'action',
          configuration: { actionType: 'save_telemetry' },
          connections: [],
        },
      ],
    } as any,
  });
  check('tenant A can save its own template', !!own.id && own.editable);

  const listB = await templatesService.findAll(TENANT_B, { page: 1, limit: 50 } as any);
  check(
    'tenant B does NOT see tenant A’s template',
    listB.meta.totalItems === BUILT_IN_RULE_CHAIN_TEMPLATES.length &&
      !listB.data.some((t: any) => t.id === own.id),
    listB.data.map((t: any) => t.name),
  );

  let crossTenantBlocked = false;
  try {
    await templatesService.findOne(TENANT_B, own.id);
  } catch {
    crossTenantBlocked = true;
  }
  check('tenant B cannot read it by id either', crossTenantBlocked);

  section('4. Instantiate — the "Use" button');
  const severity = await templateRepo.findOneByOrFail({
    slug: 'severity-routing',
  });
  const used = await templatesService.instantiate(TENANT_A, USER, severity.id, {});

  const createdChain = await chainRepo.findOneByOrFail({
    id: (used.ruleChain as any).id,
  });
  const createdNodes = await nodeRepo.find({
    where: { ruleChainId: createdChain.id },
  });

  check('a rule chain row exists', !!createdChain.id);
  check(
    'it lands disabled (placeholders may need editing first)',
    createdChain.enabled === false,
    createdChain.enabled,
  );
  check(
    `all ${severity.definition.nodes.length} nodes were created`,
    createdNodes.length === severity.definition.nodes.length,
    createdNodes.length,
  );

  // The important one: index-based edges must have become real node ids.
  const switchNode = createdNodes.find((n) => n.type === ('switch' as any));
  const realIds = new Set(createdNodes.map((n) => n.id));
  const edges = switchNode?.connections ?? [];
  check(
    'the switch has its 3 edges',
    edges.length === 3,
    edges.map((e) => e.connectionType),
  );
  check(
    'every edge target is a REAL node id, not an index or a tmp id',
    edges.length > 0 && edges.every((e) => realIds.has(e.targetNodeId)),
    edges.map((e) => e.targetNodeId),
  );
  check(
    'the routes survived (critical / warning / normal)',
    ['critical', 'warning', 'normal'].every((route) =>
      edges.some((e) => e.connectionType === route),
    ),
    edges.map((e) => e.connectionType),
  );
  check(
    'rootNodeId points at the switch',
    createdChain.rootNodeId === switchNode?.id,
    { rootNodeId: createdChain.rootNodeId, switchId: switchNode?.id },
  );
  check('the saved graph has no issues', used.issues.length === 0, used.issues);

  section('5. Usage counting');
  const afterOne = await templateRepo.findOneByOrFail({ id: severity.id });
  check('usageCount incremented to 1', afterOne.usageCount === 1, afterOne.usageCount);
  check('lastUsedAt was set', !!afterOne.lastUsedAt);

  const again = await templatesService.instantiate(TENANT_A, USER, severity.id, {
    enabled: true,
  });
  const afterTwo = await templateRepo.findOneByOrFail({ id: severity.id });
  check('usageCount incremented to 2', afterTwo.usageCount === 2, afterTwo.usageCount);
  check(
    'the name was de-duplicated, not rejected',
    (again.ruleChain as any).name !== createdChain.name,
    [(createdChain as any).name, (again.ruleChain as any).name],
  );
  check(
    'enabled: true is honoured',
    (again.ruleChain as any).enabled === true,
  );

  section('6. Guard rails');
  let builtInWriteBlocked = '';
  try {
    await templatesService.update(TENANT_A, severity.id, { name: 'Hijacked' });
  } catch (error: any) {
    builtInWriteBlocked = error?.status === 403 ? '403' : String(error?.status);
  }
  check('updating a built-in is 403', builtInWriteBlocked === '403', builtInWriteBlocked);

  let builtInDeleteBlocked = '';
  try {
    await templatesService.remove(TENANT_A, severity.id);
  } catch (error: any) {
    builtInDeleteBlocked = error?.status === 403 ? '403' : String(error?.status);
  }
  check('deleting a built-in is 403', builtInDeleteBlocked === '403', builtInDeleteBlocked);

  let invalidRejected: any = null;
  try {
    await templatesService.create(TENANT_A, USER, {
      name: 'Broken template',
      definition: {
        nodes: [
          // create_alarm without alarmType — a required field.
          {
            name: 'Bad alarm',
            type: 'action',
            configuration: { actionType: 'create_alarm' },
            connections: [],
          },
        ],
      } as any,
    });
  } catch (error: any) {
    invalidRejected = error?.getResponse?.() ?? error?.response;
  }
  check(
    'an invalid definition is a 400 listing the missing field',
    Array.isArray(invalidRejected?.errors) &&
      invalidRejected.errors.some((e: string) => /required/i.test(e)),
    invalidRejected,
  );

  let bothSourcesRejected = false;
  try {
    await templatesService.create(TENANT_A, USER, {
      name: 'Two sources',
      definition: { nodes: [] } as any,
      fromRuleChainId: createdChain.id,
    });
  } catch {
    bothSourcesRejected = true;
  }
  check('definition + fromRuleChainId together is rejected', bothSourcesRejected);

  section('7. Capture an existing chain');
  const captured = await templatesService.create(TENANT_A, USER, {
    name: 'Captured from a chain',
    category: 'Internal',
    fromRuleChainId: createdChain.id,
  });
  check(
    'the captured definition has the same node count',
    captured.definition.nodes.length === createdNodes.length,
    captured.definition.nodes.length,
  );
  check(
    'captured edges are index-based again (portable)',
    captured.definition.nodes.some((n: any) =>
      (n.connections ?? []).every((c: any) => Number.isInteger(c.targetNodeIndex)),
    ),
  );
  check('the captured template validates clean', captured.issues.length === 0, captured.issues);

  const roundTrip = await templatesService.instantiate(
    TENANT_A,
    USER,
    captured.id,
    { name: 'Round trip' },
  );
  const roundTripNodes = await nodeRepo.find({
    where: { ruleChainId: (roundTrip.ruleChain as any).id },
  });
  check(
    'instantiating the captured template rebuilds the same graph',
    roundTripNodes.length === createdNodes.length,
    roundTripNodes.length,
  );

  let capturedCrossTenant = false;
  try {
    await templatesService.create(TENANT_B, USER, {
      name: 'Steal it',
      fromRuleChainId: createdChain.id,
    });
  } catch {
    capturedCrossTenant = true;
  }
  check(
    'tenant B cannot capture tenant A’s chain as a template',
    capturedCrossTenant,
  );

  section('8. A template-built chain actually routes');
  /**
   * The real engine over the real nodes, with only the SWITCH processor real
   * and the action nodes stubbed to record which one was reached.
   *
   * Stubbed because a real `create_alarm` action writes an alarm and needs
   * half the application injected; the question here is not whether an action
   * works — it is whether the edges a template produced send a message down
   * the branch it names. A switch is the hard case: its routes are its own
   * `cases[].outputRoute` strings, not success/failure, and the engine follows
   * an edge only when `connectionType` matches the route the processor
   * returned.
   */
  // The engine's own per-node trace is the source of truth for which branch
  // ran — a processor is handed only the message and its config, not the node,
  // so a stub cannot name itself.
  const passthroughProcessor = {
    process: async (input: any) => ({
      success: true,
      route: 'success',
      data: input.data,
    }),
  };
  const switchProcessor = new SwitchNodeProcessor();
  const factoryStub: any = {
    getProcessor: (type: string) =>
      type === 'switch' ? switchProcessor : passthroughProcessor,
  };
  const engine = new RuleEngineService(
    rulesService,
    factoryStub,
    nodeRepo,
    chainRepo,
  );

  const routeCases: Array<[number, string]> = [
    [70, 'Critical alarm'],
    [40, 'Warning alarm'],
    [20, 'Store normal reading'],
  ];
  for (const [temperature, expected] of routeCases) {
    const result = await engine.testChain(TENANT_A, createdChain.id, {
      type: 'TELEMETRY',
      data: { temperature },
    } as any);
    const path = (result.trace ?? []).map((t: any) => t.nodeName);
    check(
      `temperature ${temperature} → "${expected}"`,
      result.success &&
        path.length === 2 &&
        path[0] === 'Grade the reading' &&
        path[1] === expected,
      (result.trace ?? []).map((t: any) => `${t.nodeName}:${t.route}`),
    );
  }

  const before = await chainRepo.findOneByOrFail({ id: createdChain.id });
  check(
    'three test runs left the execution counters at zero',
    before.executionCount === 0 &&
      before.successCount === 0 &&
      before.failureCount === 0,
    {
      executionCount: before.executionCount,
      successCount: before.successCount,
      failureCount: before.failureCount,
    },
  );

  await dataSource.destroy();

  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — templates list, instantiate, usage, guard rails and capture all behave',
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nFAILED:', error?.message);
  console.error(error?.stack);
  process.exit(1);
});
