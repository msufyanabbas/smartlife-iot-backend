import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Converter } from './entities/converter.entity';
import { Device } from '../devices/entities/device.entity';
import {
  PaginatedResponseDto,
} from '@common/dto/pagination.dto';
import { UserRole } from '@common/enums/index.enum';
import { ConverterDirection, ConverterType } from './converter.enums';
import {
  CONVERTER_CATALOGUE,
  listConverterCatalogue,
  validateConverterConfig,
} from './converter-catalogue';
import {
  ConvertContext,
  ConverterExecutionResult,
  ConverterExecutionService,
} from './converter-execution.service';
import { CreateConverterDto } from './dto/create-converter.dto';
import { UpdateConverterDto } from './dto/update-converter.dto';
import { QueryConvertersDto } from './dto/query-converters.dto';
import { TestConverterDto } from './dto/test-converter.dto';

/** The caller, reduced to what scoping needs. */
export interface ConverterCaller {
  id: string;
  tenantId?: string;
  role: UserRole;
}

/** What `convert()` hands back on top of the raw execution result. */
export interface ConvertOutcome extends ConverterExecutionResult {
  converterId: string;
  converterName: string;
  type: ConverterType;
  direction: ConverterDirection;
}

/**
 * Sortable columns, as an allowlist. `sortBy` lands in an ORDER BY clause that
 * QueryBuilder does not parameterise, so an arbitrary string here is an
 * injection point — the same allowlist IntegrationsService.findAll() keeps.
 */
const SORTABLE = [
  'createdAt',
  'updatedAt',
  'name',
  'type',
  'direction',
  'enabled',
  'lastExecuted',
  'executionCount',
];

@Injectable()
export class ConvertersService {
  private readonly logger = new Logger(ConvertersService.name);

  constructor(
    @InjectRepository(Converter)
    private readonly converterRepository: Repository<Converter>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly executor: ConverterExecutionService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CATALOGUE
  // ══════════════════════════════════════════════════════════════════════════

  getCatalogue() {
    return listConverterCatalogue();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(caller: ConverterCaller, dto: CreateConverterDto): Promise<Converter> {
    const tenantId = this.requireTenant(caller);
    const configuration = dto.configuration ?? {};

    this.assertValid(dto.type, dto.direction, configuration);

    const clash = await this.converterRepository.findOne({
      where: { tenantId, name: dto.name },
    });
    if (clash) {
      throw new ConflictException(
        `A converter named "${dto.name}" already exists for this tenant`,
      );
    }

    const converter = this.converterRepository.create({
      ...dto,
      configuration,
      tenantId,
      userId: caller.id,
      enabled: dto.enabled ?? true,
      debugMode: dto.debugMode ?? false,
      createdBy: caller.id,
    });

    const saved = await this.converterRepository.save(converter);
    this.logger.log(
      `Created ${saved.type}/${saved.direction} converter "${saved.name}" (${saved.id}) for tenant ${tenantId}`,
    );
    return saved;
  }

  async findAll(caller: ConverterCaller, query: QueryConvertersDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'updatedAt',
      sortOrder = 'DESC',
      direction,
      type,
      enabled,
    } = query;

    const orderColumn = SORTABLE.includes(sortBy) ? sortBy : 'updatedAt';
    const order = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const qb = this.converterRepository.createQueryBuilder('converter');

    // SUPER_ADMIN has no tenantId and is expected to see everything, so it gets
    // no predicate rather than one on `tenantId: undefined` — which TypeORM
    // would render as `tenantId IS NULL` and return nothing at all.
    if (caller.role === UserRole.SUPER_ADMIN && !caller.tenantId) {
      qb.where('1 = 1');
    } else {
      qb.where('converter.tenantId = :tenantId', {
        tenantId: this.requireTenant(caller),
      });
    }

    if (direction) qb.andWhere('converter.direction = :direction', { direction });
    if (type) qb.andWhere('converter.type = :type', { type });
    if (enabled !== undefined) {
      qb.andWhere('converter.enabled = :enabled', { enabled });
    }
    if (search) {
      qb.andWhere(
        '(converter.name ILIKE :search OR converter.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy(`converter.${orderColumn}`, order)
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();

    // `health` is derived (see Converter.health()), so it is attached here
    // rather than stored. The list page's badge needs it and a column for it
    // would be a third source of truth next to `enabled` and `lastError`.
    const data = rows.map((row) => this.decorate(row));

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, caller: ConverterCaller): Promise<Converter> {
    const where: Record<string, unknown> = { id };
    if (!(caller.role === UserRole.SUPER_ADMIN && !caller.tenantId)) {
      where.tenantId = this.requireTenant(caller);
    }

    const converter = await this.converterRepository.findOne({ where });
    if (!converter) {
      throw new NotFoundException(`Converter ${id} not found`);
    }
    return converter;
  }

  /** `findOne` plus the derived fields the detail page shows. */
  async findOneDecorated(id: string, caller: ConverterCaller) {
    return this.decorate(await this.findOne(id, caller));
  }

  async update(
    id: string,
    caller: ConverterCaller,
    dto: UpdateConverterDto,
  ): Promise<Converter> {
    const converter = await this.findOne(id, caller);

    // The merged triple is what gets validated, not the patch: an edit that
    // changes `type` to `script` while leaving a `json` configuration behind
    // would otherwise save cleanly and then fail on every message.
    const type = dto.type ?? converter.type;
    const direction = dto.direction ?? converter.direction;
    const configuration = dto.configuration ?? converter.configuration ?? {};
    this.assertValid(type, direction, configuration);

    if (dto.name && dto.name !== converter.name) {
      const clash = await this.converterRepository.findOne({
        where: { tenantId: converter.tenantId, name: dto.name, id: Not(id) },
      });
      if (clash) {
        throw new ConflictException(
          `A converter named "${dto.name}" already exists for this tenant`,
        );
      }
    }

    Object.assign(converter, dto, { type, direction, configuration });
    converter.updatedBy = caller.id;

    // An operator correcting a converter is saying it is fixed; leaving the old
    // message on the row makes the list page show ERROR for a converter that
    // has just been repaired and not yet re-run.
    if (dto.configuration !== undefined || dto.type || dto.direction) {
      converter.lastError = undefined;
    }

    return this.converterRepository.save(converter);
  }

  /** Soft delete — `deleted_at`, in line with every other entity here. */
  async remove(id: string, caller: ConverterCaller): Promise<{ message: string }> {
    const converter = await this.findOne(id, caller);
    converter.deletedBy = caller.id;
    await this.converterRepository.save(converter);
    await this.converterRepository.softRemove(converter);
    return { message: `Converter "${converter.name}" deleted` };
  }

  async setEnabled(
    id: string,
    caller: ConverterCaller,
    enabled: boolean,
  ): Promise<Converter> {
    const converter = await this.findOne(id, caller);
    converter.enabled = enabled;
    converter.updatedBy = caller.id;
    // Re-enabling is a statement that the problem is fixed, same as an edit.
    if (enabled) converter.lastError = undefined;
    return this.converterRepository.save(converter);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The programmatic entry point. Loads the converter, runs it, and records the
   * run on the row.
   *
   * Counters are written with a fresh `save()` of the loaded entity rather than
   * SQL arithmetic because `recordExecution()` also recomputes
   * `averageExecutionTime` from the previous value — the same trade `RuleChain`
   * makes. Two concurrent conversions of one converter can therefore lose a
   * count; that is acceptable for a health indicator and is why the dispatch
   * path must not depend on these numbers.
   *
   * Bookkeeping never fails a conversion: a counter write that throws is logged
   * and swallowed, because this sits on the uplink hot path.
   */
  async convert(
    tenantId: string,
    converterId: string,
    payload: unknown,
    context: ConvertContext = {},
  ): Promise<ConvertOutcome> {
    const converter = await this.converterRepository.findOne({
      where: { id: converterId, tenantId },
    });
    if (!converter) {
      throw new NotFoundException(
        `Converter ${converterId} not found for this tenant`,
      );
    }
    if (!converter.enabled) {
      throw new BadRequestException(
        `Converter "${converter.name}" is disabled`,
      );
    }

    const result = await this.executor.run(converter, payload, context);
    await this.recordExecution(converter, result);

    return {
      ...result,
      // The trace is kept for a debug-mode converter and for the test route;
      // on the hot path it is dropped, because one step per mapping rule per
      // message would be the bulk of the object handed to the caller.
      trace: converter.debugMode ? result.trace : [],
      converterId: converter.id,
      converterName: converter.name,
      type: converter.type,
      direction: converter.direction,
    };
  }

  /**
   * Convert using whichever converter the device is assigned, if any.
   *
   * The assignment is read from `device.metadata` — `uplinkConverterId` /
   * `downlinkConverterId`, with `converterId` as a direction-agnostic fallback.
   * That column is already the device's free-form static store and already
   * holds `codecId` the same way (see Device entity, "Metadata" section), so no
   * devices-module change is needed to make this work. A first-class column
   * would be better for querying "which devices use this converter"; the
   * one-line change for it is in the report, not applied here, because
   * assigning a converter to a device is explicitly out of scope.
   *
   * Returns `null` when the device has no converter assigned, so a caller can
   * fall back to `CodecRegistryService` exactly as it does today instead of
   * having to treat "no converter" as an error.
   */
  async convertForDevice(
    tenantId: string,
    deviceId: string,
    payload: unknown,
    context: ConvertContext = {},
    direction: ConverterDirection = ConverterDirection.UPLINK,
  ): Promise<ConvertOutcome | null> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found for this tenant`);
    }

    const metadata = (device.metadata ?? {}) as Record<string, any>;
    const assigned =
      direction === ConverterDirection.DOWNLINK
        ? metadata.downlinkConverterId
        : metadata.uplinkConverterId;
    const converterId = assigned ?? metadata.converterId;

    if (!converterId || typeof converterId !== 'string') return null;

    return this.convert(tenantId, converterId, payload, {
      ...context,
      metadata: {
        // Device context the converter would otherwise have to be told twice:
        // a codec converter needs devEUI/fPort, and a script often wants the
        // device key. An explicit caller value still wins.
        deviceId: device.id,
        deviceKey: device.deviceKey,
        ...(metadata.devEUI ? { devEUI: metadata.devEUI } : {}),
        ...(context.metadata ?? {}),
      },
    });
  }

  /**
   * `POST /converters/:id/test`.
   *
   * Runs the real executor and **always** returns the trace, whatever
   * `debugMode` says — a test with no trace is the thing the configuration page
   * cannot use. Counters are deliberately not touched: a few sample payloads
   * must not make a converter's health look worse than its real traffic did,
   * the same reasoning as `RuleEngineService.testChain()` and
   * `persistStats = false`.
   *
   * Unlike a rule-chain test, this has no side effects at all — a converter
   * transforms a value and writes nothing.
   */
  async test(id: string, caller: ConverterCaller, dto: TestConverterDto) {
    const converter = await this.findOne(id, caller);

    if (dto.payload === undefined) {
      throw new BadRequestException({
        message: 'A sample payload is required',
        errors: ['"payload" is required'],
      });
    }
    if (
      converter.direction === ConverterDirection.DOWNLINK &&
      !dto.command &&
      converter.type === ConverterType.CODEC
    ) {
      throw new BadRequestException({
        message: 'This downlink converter needs a command to encode',
        errors: ['"command" is required: {type, params}'],
      });
    }

    const result = await this.executor.run(converter, dto.payload, {
      metadata: dto.metadata,
      command: dto.command,
    });

    return {
      ...result,
      converterId: converter.id,
      converterName: converter.name,
      type: converter.type,
      direction: converter.direction,
      /** Stated in the response so the UI does not have to claim it. */
      statsRecorded: false,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Validate against the manifest and, for a script, compile it.
   *
   * Every problem is reported at once through
   * `BadRequestException({message, errors})` — HttpExceptionFilter forwards the
   * `errors` array and the frontend renders it, so a form does not fix one
   * missing field per round trip.
   */
  private assertValid(
    type: ConverterType,
    direction: ConverterDirection,
    configuration: Record<string, any>,
  ): void {
    const errors = validateConverterConfig(type, direction, configuration);

    if (type === ConverterType.SCRIPT && typeof configuration.script === 'string') {
      try {
        this.executor.assertScriptCompiles(configuration.script);
      } catch (error: any) {
        errors.push(`Script has a syntax error: ${error?.message ?? 'unknown'}`);
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: `${CONVERTER_CATALOGUE[type]?.label ?? type} configuration is incomplete`,
        errors,
      });
    }
  }

  private requireTenant(caller: ConverterCaller): string {
    if (!caller.tenantId) {
      throw new BadRequestException(
        'This operation needs a tenant context; the caller has none',
      );
    }
    return caller.tenantId;
  }

  private decorate(converter: Converter) {
    return Object.assign(converter, {
      health: converter.health(),
      successRate: Math.round(converter.getSuccessRate() * 10) / 10,
      healthy: converter.isHealthy(),
    });
  }

  private async recordExecution(
    converter: Converter,
    result: ConverterExecutionResult,
  ): Promise<void> {
    try {
      converter.recordExecution(result.success, result.durationMs, result.error);
      await this.converterRepository.save(converter);
    } catch (error: any) {
      this.logger.warn(
        `Failed to record execution stats for converter ${converter.id}: ${error?.message}`,
      );
    }
  }

  /**
   * Used by the verification script and by any future dispatch path: every
   * enabled converter of a direction for a tenant.
   */
  async listEnabled(
    tenantId: string,
    direction?: ConverterDirection,
  ): Promise<Converter[]> {
    return this.converterRepository.find({
      where: {
        tenantId,
        enabled: true,
        ...(direction ? { direction } : {}),
        deletedAt: IsNull(),
      },
      order: { name: 'ASC' },
    });
  }
}
