/**
 * Proves the AI module's dependency injection actually resolves.
 *
 *   npm run check:ai-wiring
 *
 * WHY THIS EXISTS: `AiInsightsService` deliberately does NOT import
 * `TelemetryModule` — that import closes a module-load cycle through
 * `NotificationsService` and crash-loops `bootstrap()`. It resolves the
 * service through `ModuleRef` with a STRING token instead, and a string token
 * only works if something registers it. Nothing about that is visible to
 * `tsc`: the wrong token typechecks perfectly and throws at
 * `onModuleInit`, i.e. at boot, in the container.
 *
 * So this builds the real DI graph with stubbed infrastructure and asserts the
 * lookup succeeds. It is the same class of guard as `check:swagger`.
 */
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiInsightsService } from '../src/modules/ai/ai-insights.service';
import { AiService } from '../src/modules/ai/ai.service';
import { AiModel } from '../src/modules/ai/entities/ai-model.entity';
import { AiRequestNodeProcessor } from '../src/modules/nodes/processors/ai-request-node';
import { AiController } from '../src/modules/ai/ai.controller';

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

const repoStub = {
  find: async () => [],
  findOne: async () => null,
  create: (x: any) => x,
  save: async (x: any) => x,
  update: async () => undefined,
  softRemove: async () => undefined,
  createQueryBuilder: () => ({
    addSelect: () => ({
      where: () => ({ andWhere: () => ({ getOne: async () => null }) }),
    }),
  }),
};

/** Stands in for the real TelemetryModule, registering the same tokens. */
const telemetryStub = {
  getStatistics: async () => ({ keys: [] }),
  getTimeSeries: async () => [],
};

@Module({
  controllers: [AiController],
  providers: [
    { provide: 'TelemetryService', useValue: telemetryStub },
    AiService,
    AiInsightsService,
    AiRequestNodeProcessor,
    { provide: getRepositoryToken(AiModel), useValue: repoStub },
  ],
  exports: ['TelemetryService'],
})
class HarnessModule {}

(async () => {
  console.log('\n── AI dependency injection ─────────────');
  let moduleRef;
  try {
    moduleRef = await Test.createTestingModule({
      imports: [HarnessModule],
    }).compile();
    ok('the module graph compiles', true);
  } catch (error: any) {
    ok('the module graph compiles', false, error?.message);
    process.exit(1);
  }

  // init() is what fires onModuleInit — the whole point of this check.
  try {
    await moduleRef.init();
    ok('onModuleInit runs without throwing', true);
  } catch (error: any) {
    ok('onModuleInit runs without throwing', false, error?.message);
  }

  const insights = moduleRef.get(AiInsightsService);
  ok(
    "AiInsightsService resolved TelemetryService through its string token",
    (insights as any).telemetry === telemetryStub,
    (insights as any).telemetry,
  );

  const node = moduleRef.get(AiRequestNodeProcessor);
  ok('the ai_request processor was constructed with AiService',
    !!(node as any).ai && (node as any).ai instanceof AiService);

  // A node with no modelId must fail cleanly rather than throw.
  const result = await node.process({ data: {}, metadata: {} } as any, {});
  ok('ai_request without a modelId routes to failure with a reason',
    result.route === 'failure' && /modelId/.test(result.error ?? ''),
    result);

  const noTenant = await node.process(
    { data: {}, metadata: {} } as any,
    { modelId: 'x', userPrompt: 'hi' },
  );
  ok('ai_request without a tenant in the message is refused',
    noTenant.route === 'failure' && /tenant/i.test(noTenant.error ?? ''),
    noTenant);

  // ── The controller's tenant guard ───────────────────────────────────────
  //
  // This exists because a careless codemod once rewrote the helper's own
  // return into a call to itself — `return this.tenantOf(user)` — which
  // typechecks perfectly, returns `string`, and blows the stack on EVERY
  // authenticated route. Infinite recursion is invisible to tsc and to any
  // check that does not actually invoke the thing.
  const controller = moduleRef.get(AiController);
  const tenantOf = (controller as any).tenantOf.bind(controller);

  let recursed = false;
  let value: unknown;
  try {
    value = tenantOf({ id: 'u', tenantId: 'tenant-123' });
  } catch (e: any) {
    recursed = /call stack/i.test(e?.message ?? '');
  }
  ok('tenantOf() returns the tenant id and does NOT recurse',
    value === 'tenant-123' && !recursed, { value, recursed });

  let refusedTenantless = false;
  try {
    tenantOf({ id: 'u' });
  } catch (e: any) {
    refusedTenantless = !/call stack/i.test(e?.message ?? '');
  }
  ok('a tenant-less caller is refused with a real message, not a stack overflow',
    refusedTenantless);

  await moduleRef.close();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — the AI graph wires up and resolves at runtime',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
