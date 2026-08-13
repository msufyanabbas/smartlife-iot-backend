import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VM, VMScript } from 'vm2';
import { Script } from './entities/script.entity';
import { CreateScriptDto } from './dto/create-script.dto';
import { UpdateScriptDto } from './dto/update-script.dto';
import { ExecuteScriptDto, TestScriptDto } from './dto/execute-script.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '../../common/dto/pagination.dto';
import { ScriptType } from '@common/enums/index.enum';

/**
 * The shape Repository.update() accepts — derived from the repository rather
 * than deep-imported from typeorm/query-builder/QueryPartialEntity, whose
 * generic does not resolve cleanly under this tsconfig. Allows `() => 'SQL'`
 * for raw column arithmetic. Same trick as IntegrationDispatchService.
 */
type ScriptUpdate = Parameters<Repository<Script>['update']>[1];

/** Hard ceiling on sandbox wall-clock time. Per-script `timeout` may only lower it. */
export const MAX_SCRIPT_TIMEOUT_MS = 3000;
const MIN_SCRIPT_TIMEOUT_MS = 50;

/** Untrusted code produces the log lines, so both count and size are bounded. */
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_LENGTH = 1000;

/** Columns a client may sort by. Anything else is interpolated into SQL. */
const SORTABLE_COLUMNS = new Set([
  'name',
  'type',
  'version',
  'lines',
  'lastModified',
  'executionCount',
  'errorCount',
  'lastExecutedAt',
  'createdAt',
  'updatedAt',
]);

/**
 * Named entry points recognised per script type, in priority order.
 *
 * ThingsBoard scripts are plain function bodies (`return msg.temperature > 30`).
 * We accept that AND the named-function style (`function Filter(msg, …) {…}`),
 * because both are in circulation in TB documentation and exports.
 */
const ENTRY_POINTS: Record<string, string[]> = {
  [ScriptType.FILTER]: ['Filter', 'filter'],
  [ScriptType.TRANSFORMATION]: ['Transform', 'transform'],
  [ScriptType.ENRICHMENT]: ['Enrich', 'enrich'],
  [ScriptType.VALIDATION]: ['Validate', 'validate'],
  [ScriptType.PROCESSING]: ['main', 'Process'],
  [ScriptType.AGGREGATION]: ['main', 'Aggregate'],
};

export interface ScriptInput {
  msg: Record<string, any>;
  metadata?: Record<string, any>;
  msgType?: string;
}

export interface ScriptExecutionResult {
  success: boolean;
  result: any;
  executionTime: number;
  logs: string[];
  error?: string;
}

export interface ScriptTestResult extends ScriptExecutionResult {
  passed?: boolean;
  expectedResult?: any;
}

interface NormalisedInput {
  msg: Record<string, any>;
  metadata: Record<string, any>;
  msgType: string;
}

@Injectable()
export class ScriptsService {
  private readonly logger = new Logger(ScriptsService.name);

  constructor(
    @InjectRepository(Script)
    private readonly scriptRepository: Repository<Script>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    userId: string,
    tenantId: string,
    createScriptDto: CreateScriptDto,
  ): Promise<Script> {
    // Scripts are now executed for real, so a script that cannot compile is
    // rejected at write time instead of failing on every message at runtime.
    this.assertCompiles(createScriptDto.code, createScriptDto.type);

    const lines = createScriptDto.code.split('\n').length;

    const script = this.scriptRepository.create({
      ...createScriptDto,
      tenantId,
      userId,
      createdBy: userId,
      lines,
      lastModified: new Date(),
    });

    return await this.scriptRepository.save(script);
  }

  async findAll(tenantId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'lastModified',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    // sortBy is interpolated into the ORDER BY clause, so it is allowlisted.
    const orderColumn = SORTABLE_COLUMNS.has(sortBy) ? sortBy : 'lastModified';
    const direction = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const queryBuilder = this.scriptRepository
      .createQueryBuilder('script')
      .where('script.tenantId = :tenantId', { tenantId });

    if (search) {
      queryBuilder.andWhere(
        '(script.name ILIKE :search OR script.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder.orderBy(`script.${orderColumn}`, direction).skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, tenantId: string): Promise<Script> {
    const script = await this.scriptRepository.findOne({
      where: { id, tenantId },
    });

    if (!script) {
      throw new NotFoundException('Script not found');
    }

    return script;
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    updateScriptDto: UpdateScriptDto,
  ): Promise<Script> {
    const script = await this.findOne(id, tenantId);

    if (script.isSystem) {
      throw new BadRequestException('System scripts cannot be modified');
    }

    if (updateScriptDto.code) {
      this.assertCompiles(
        updateScriptDto.code,
        updateScriptDto.type ?? script.type,
      );
      updateScriptDto['lines'] = updateScriptDto.code.split('\n').length;
    }

    Object.assign(script, updateScriptDto);
    script.updatedBy = userId;
    script.lastModified = new Date();

    return await this.scriptRepository.save(script);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const script = await this.findOne(id, tenantId);

    if (script.isSystem) {
      throw new BadRequestException('System scripts cannot be deleted');
    }

    await this.scriptRepository.softRemove(script);
  }

  async getStatistics(tenantId: string) {
    const total = await this.scriptRepository.count({ where: { tenantId } });

    const byTypeResult = await this.scriptRepository
      .createQueryBuilder('script')
      .select('script.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('script.tenantId = :tenantId', { tenantId })
      .groupBy('script.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const totals = await this.scriptRepository
      .createQueryBuilder('script')
      .select('COALESCE(SUM(script.executionCount), 0)', 'executions')
      .addSelect('COALESCE(SUM(script.errorCount), 0)', 'errors')
      .where('script.tenantId = :tenantId', { tenantId })
      .getRawOne();

    return {
      total,
      byType,
      totalExecutions: parseInt(totals?.executions ?? '0'),
      totalErrors: parseInt(totals?.errors ?? '0'),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run a stored script against a message.
   *
   * Never throws for script-authored failures — a broken tenant script must not
   * surface as a 500, and the rule engine treats a failed run as a routing
   * decision rather than an exception. Only a missing script (404) throws.
   */
  async execute(
    id: string,
    tenantId: string,
    input: ScriptInput | ExecuteScriptDto,
  ): Promise<ScriptExecutionResult> {
    const script = await this.findOne(id, tenantId);
    const startTime = Date.now();
    const logs: string[] = [];

    const normalised: NormalisedInput = {
      msg: input?.msg ?? {},
      metadata: input?.metadata ?? {},
      msgType: input?.msgType ?? 'POST_TELEMETRY_REQUEST',
    };

    try {
      const raw = this.runInSandbox(script, normalised, logs);
      const result = this.coerceResult(
        script.type,
        this.sanitize(raw),
        normalised,
      );

      const executionTime = Date.now() - startTime;
      await this.recordExecution(script.id, true, executionTime);

      return { success: true, result, executionTime, logs };
    } catch (err: any) {
      const executionTime = Date.now() - startTime;
      const error = this.describeError(err, script);

      await this.recordExecution(script.id, false, executionTime, error);
      this.logger.warn(`Script "${script.name}" (${script.id}) failed: ${error}`);

      return { success: false, result: null, executionTime, logs, error };
    }
  }

  /**
   * Execute with an optional expected-result assertion. Thin wrapper over
   * execute() so the tested path is exactly the production path.
   */
  async test(
    id: string,
    tenantId: string,
    testInput: TestScriptDto,
  ): Promise<ScriptTestResult> {
    const executeResult = await this.execute(id, tenantId, {
      msg: testInput.msg,
      metadata: testInput.metadata,
      msgType: testInput.msgType,
    });

    let passed: boolean | undefined;
    if (testInput.expectedResult !== undefined) {
      passed =
        JSON.stringify(executeResult.result) ===
        JSON.stringify(testInput.expectedResult);
    }

    return {
      ...executeResult,
      passed,
      expectedResult: testInput.expectedResult,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SANDBOX
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run user code inside a vm2 sandbox.
   *
   * Security posture:
   * - vm2 gives the script a fresh V8 context with **no** Node globals, so
   *   `require`, `process`, `fetch`, `Buffer`, `setTimeout` and friends are all
   *   simply absent (ReferenceError), not merely discouraged.
   * - Only msg / metadata / msgType / console are injected. Host intrinsics
   *   (Object, Array, JSON, Math…) are deliberately NOT injected: the sandbox
   *   has its own, and handing a script a *host* constructor is the classic
   *   route back into the host realm via `.constructor.constructor`.
   * - `eval: false` and `wasm: false` block the two remaining ways to reach a
   *   fresh compiler; `allowAsync: false` blocks async/await, which matters
   *   because the timeout can only interrupt synchronous execution.
   * - msg/metadata are deep-cloned in, and results are deep-cloned out
   *   (sanitize), so a script can neither mutate the caller's objects nor hand
   *   back a live proxy into its own context.
   */
  private runInSandbox(
    script: Script,
    input: NormalisedInput,
    logs: string[],
  ): any {
    const sandbox = {
      msg: this.clone(input.msg),
      metadata: this.clone(input.metadata),
      msgType: input.msgType,
      // vm2 leaves Buffer reachable inside the sandbox. Nothing in a telemetry
      // script needs it, and it is a host-realm constructor, so shadow it away.
      // (`eval: false` already blocks the .constructor.constructor route out of
      // any such object — this is belt-and-braces, not the primary defence.)
      Buffer: undefined,
      console: {
        log: (...args: any[]) => this.pushLog(logs, '', args),
        info: (...args: any[]) => this.pushLog(logs, '', args),
        error: (...args: any[]) => this.pushLog(logs, 'ERROR', args),
        warn: (...args: any[]) => this.pushLog(logs, 'WARN', args),
      },
    };

    const vm = new VM({
      timeout: this.resolveTimeout(script.timeout),
      sandbox,
      eval: false,
      wasm: false,
      allowAsync: false,
    });

    // The wrapper is a single expression statement, so vm.run() hands back the
    // IIFE's return value directly — no write-through global needed.
    return vm.run(new VMScript(this.buildWrapper(script.code, script.type)));
  }

  /**
   * Wrap user code as a function body, exactly once.
   *
   * A `return` at the top level of the user's code exits immediately (the
   * ThingsBoard style). If it instead *declares* an entry function, execution
   * falls through to the dispatch lines below it — hoisting makes the
   * declaration visible there. `typeof X === 'function'` on an undeclared
   * identifier is safe even under strict mode, so absent entry points cost
   * nothing.
   *
   * Emitting the code once matters: a wrapper that inlines the source in two
   * branches double-evaluates side effects, and turns any multi-statement
   * script into a syntax error the moment it is spliced into `return (…)`.
   */
  private buildWrapper(code: string, type: ScriptType): string {
    const entries = ENTRY_POINTS[type] ?? ['main'];
    const dispatch = entries
      .map(
        (name) =>
          `  if (typeof ${name} === 'function') return ${name}(msg, metadata, msgType);`,
      )
      .join('\n');

    return [
      '(function (msg, metadata, msgType) {',
      '  "use strict";',
      code,
      dispatch,
      '  return undefined;',
      '})(msg, metadata, msgType);',
    ].join('\n');
  }

  /** Compile-only check used by create/update to reject syntax errors early. */
  private assertCompiles(code: string, type: ScriptType): void {
    try {
      new VMScript(this.buildWrapper(code, type)).compile();
    } catch (err: any) {
      throw new BadRequestException(
        `Script has a syntax error: ${err?.message ?? 'unknown'}`,
      );
    }
  }

  /** Per-script timeout, clamped so a DB edit cannot exceed the platform limit. */
  private resolveTimeout(configured?: number): number {
    const value = Number(configured);
    if (!Number.isFinite(value) || value <= 0) return MAX_SCRIPT_TIMEOUT_MS;
    return Math.min(Math.max(Math.round(value), MIN_SCRIPT_TIMEOUT_MS), MAX_SCRIPT_TIMEOUT_MS);
  }

  /**
   * Shape the raw return value according to the script's type — the half of the
   * ThingsBoard contract that lives outside the sandbox, so that untrusted code
   * never participates in deciding its own output shape.
   */
  private coerceResult(
    type: ScriptType,
    raw: any,
    input: NormalisedInput,
  ): any {
    const isPlainObject =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw);

    switch (type) {
      case ScriptType.FILTER:
        return typeof raw === 'boolean' ? raw : Boolean(raw);

      case ScriptType.TRANSFORMATION: {
        const out = isPlainObject ? raw : {};
        return {
          msg: out.msg ?? input.msg,
          metadata: out.metadata ?? input.metadata,
          msgType: out.msgType ?? input.msgType,
        };
      }

      case ScriptType.ENRICHMENT:
        return isPlainObject ? raw : {};

      case ScriptType.VALIDATION:
        if (typeof raw === 'boolean') return { valid: raw };
        if (isPlainObject) return { valid: true, ...raw };
        return { valid: true };

      default:
        // PROCESSING / AGGREGATION — pass the value through untouched.
        return raw;
    }
  }

  /**
   * Deep-copy a value out of the sandbox.
   *
   * vm2 hands back host-side proxies for objects created inside the VM; JSON
   * round-tripping severs that link and drops functions, so nothing live
   * escapes into the rest of the platform.
   */
  private sanitize(value: any): any {
    if (value === undefined || value === null) return value;

    const type = typeof value;
    if (type === 'boolean' || type === 'number' || type === 'string') {
      return value;
    }
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      return undefined;
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      throw new Error(
        'script returned a value that cannot be serialised (circular reference?)',
      );
    }
  }

  private clone<T>(value: T): T {
    try {
      return JSON.parse(JSON.stringify(value ?? {}));
    } catch {
      return {} as T;
    }
  }

  private pushLog(logs: string[], level: string, args: any[]): void {
    if (logs.length >= MAX_LOG_ENTRIES) return;

    const line = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');

    logs.push(
      `${level ? `${level}: ` : ''}${line}`.slice(0, MAX_LOG_LENGTH),
    );
  }

  /** vm2 reports timeouts as a plain Error; give the caller something actionable. */
  private describeError(err: any, script: Script): string {
    const message = err?.message ?? 'script execution failed';
    if (/script execution timed out|timed out/i.test(message)) {
      return `Script execution timed out after ${this.resolveTimeout(script.timeout)}ms`;
    }
    return message;
  }

  /**
   * Counters are incremented with SQL arithmetic so concurrent executions of
   * the same script cannot lose a count. Bookkeeping must never break a run,
   * so a failure here is logged and swallowed.
   */
  private async recordExecution(
    id: string,
    ok: boolean,
    executionTime: number,
    error?: string,
  ): Promise<void> {
    const patch: ScriptUpdate = ok
      ? {
          lastExecutedAt: new Date(),
          executionCount: () => '"executionCount" + 1',
          lastExecutionTime: executionTime,
          lastError: null,
        }
      : {
          lastExecutedAt: new Date(),
          executionCount: () => '"executionCount" + 1',
          errorCount: () => '"errorCount" + 1',
          lastExecutionTime: executionTime,
          lastError: error ?? 'unknown error',
        };

    try {
      await this.scriptRepository.update({ id }, patch);
    } catch (err: any) {
      this.logger.warn(
        `Failed to record execution stats for script ${id}: ${err.message}`,
      );
    }
  }
}
