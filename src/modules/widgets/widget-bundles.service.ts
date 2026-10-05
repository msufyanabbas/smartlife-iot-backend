import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WidgetBundle } from './entities/widget-bundle.entity';
import { WidgetType } from './entities/widget-type.entity';
import { ImportWidgetBundleDto } from './dto/bundle-io.dto';
import {
  CreateWidgetBundleDto,
  UpdateWidgetBundleDto,
  QueryWidgetBundlesDto,
} from './dto/widgets.dto';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

@Injectable()
export class WidgetBundlesService {
  constructor(
    @InjectRepository(WidgetBundle)
    private readonly widgetBundleRepository: Repository<WidgetBundle>,
    @InjectRepository(WidgetType)
    private readonly widgetTypeRepository: Repository<WidgetType>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(createDto: CreateWidgetBundleDto): Promise<WidgetBundle> {
    const existing = await this.widgetBundleRepository.findOne({
      where: { title: createDto.title },
    });

    if (existing) {
      throw new ConflictException('Widget bundle with this title already exists');
    }

    const bundle = this.widgetBundleRepository.create(createDto);
    const saved = await this.widgetBundleRepository.save(bundle);
    this.eventEmitter.emit('widget.bundle.created', { bundle: saved });
    return saved;
  }

  async findAll(
    queryDto: QueryWidgetBundlesDto,
  ): Promise<PaginatedResponseDto<WidgetBundle>> {
    const page = queryDto.page ?? 1;
    const limit = queryDto.limit ?? 10;
    const skip = (page - 1) * limit;

    const qb = this.widgetBundleRepository.createQueryBuilder('bundle');

    if (queryDto.search) {
      qb.andWhere(
        '(bundle.title ILIKE :search OR bundle.description ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    if (queryDto.tenantId) {
      qb.andWhere('bundle.tenantId = :tenantId', { tenantId: queryDto.tenantId });
    }

    if (queryDto.system !== undefined) {
      qb.andWhere('bundle.system = :system', { system: queryDto.system });
    }

    const total = await qb.getCount();
    const bundles = await qb
      .skip(skip)
      .take(limit)
      .orderBy('bundle.order', 'ASC')
      .addOrderBy('bundle.title', 'ASC')
      .getMany();

    return PaginatedResponseDto.create(bundles, page, limit, total);
  }

  async findOne(id: string): Promise<WidgetBundle> {
    const bundle = await this.widgetBundleRepository.findOne({ where: { id } });
    if (!bundle) throw new NotFoundException('Widget bundle not found');
    return bundle;
  }

  async update(id: string, updateDto: UpdateWidgetBundleDto): Promise<WidgetBundle> {
    const bundle = await this.findOne(id);

    if (bundle.system) {
      throw new BadRequestException('Cannot update system widget bundles');
    }

    if (updateDto.title && updateDto.title !== bundle.title) {
      const existing = await this.widgetBundleRepository.findOne({
        where: { title: updateDto.title },
      });
      if (existing) {
        throw new ConflictException('Widget bundle with this title already exists');
      }
    }

    Object.assign(bundle, updateDto);
    const updated = await this.widgetBundleRepository.save(bundle);
    this.eventEmitter.emit('widget.bundle.updated', { bundle: updated });
    return updated;
  }

  async remove(id: string): Promise<void> {
    const bundle = await this.findOne(id);

    if (bundle.system) {
      throw new BadRequestException('Cannot delete system widget bundles');
    }

    const widgetsCount = await this.widgetTypeRepository.count({
      where: { bundleFqn: bundle.title },
    });

    if (widgetsCount > 0) {
      throw new BadRequestException(
        `Cannot delete bundle — ${widgetsCount} widget(s) are assigned to it`,
      );
    }

    await this.widgetBundleRepository.softRemove(bundle);
    this.eventEmitter.emit('widget.bundle.deleted', { bundleId: id });
  }

  async getWidgetsInBundle(id: string): Promise<WidgetType[]> {
    const bundle = await this.findOne(id);
    return this.widgetTypeRepository.find({
      where: { bundleFqn: bundle.title },
      order: { name: 'ASC' },
    });
  }

  async addWidgetToBundle(bundleId: string, widgetTypeId: string): Promise<void> {
    const bundle = await this.findOne(bundleId);

    const widgetType = await this.widgetTypeRepository.findOne({
      where: { id: widgetTypeId },
    });
    if (!widgetType) throw new NotFoundException('Widget type not found');

    widgetType.bundleFqn = bundle.title;
    await this.widgetTypeRepository.save(widgetType);
    this.eventEmitter.emit('widget.bundle.widget.added', { bundleId, widgetTypeId });
  }

  async removeWidgetFromBundle(bundleId: string, widgetTypeId: string): Promise<void> {
    await this.findOne(bundleId);

    const widgetType = await this.widgetTypeRepository.findOne({
      where: { id: widgetTypeId },
    });
    if (!widgetType) throw new NotFoundException('Widget type not found');

    widgetType.bundleFqn = undefined;
    await this.widgetTypeRepository.save(widgetType);
    this.eventEmitter.emit('widget.bundle.widget.removed', { bundleId, widgetTypeId });
  }


  // ══════════════════════════════════════════════════════════════════════════
  // IMPORT / EXPORT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Exports a bundle together with every widget assigned to it.
   *
   * Widget types already had per-widget export, but a bundle is the unit people
   * actually share — exporting 15 widgets one at a time and reassembling them by
   * hand is not a workflow. Database ids, tenant ids and timestamps are stripped:
   * they are meaningless on the importing side and, left in, invite someone to
   * try restoring a bundle onto a tenant it does not belong to.
   */
  async exportBundle(id: string): Promise<Record<string, any>> {
    const bundle = await this.findOne(id);
    const widgets = await this.getWidgetsInBundle(id);

    return {
      // Versioned so a future format change can be detected rather than guessed.
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      bundle: {
        title: bundle.title,
        description: bundle.description,
        image: bundle.image,
        order: bundle.order,
        additionalInfo: bundle.additionalInfo,
      },
      widgets: widgets.map((widget) => ({
        name: widget.name,
        description: widget.description,
        category: widget.category,
        image: widget.image,
        iconUrl: widget.iconUrl,
        descriptor: widget.descriptor,
        settingsTemplate: widget.settingsTemplate,
        tags: widget.tags,
      })),
    };
  }

  /**
   * Creates a bundle and its widgets from an exported payload.
   *
   * Bundle membership here is by title (widgetType.bundleFqn === bundle.title),
   * so an imported bundle whose title collides with an existing one would silently
   * absorb that bundle's widgets. That is why a duplicate title is rejected unless
   * the caller explicitly opts into suffixing.
   */
  async importBundle(dto: ImportWidgetBundleDto): Promise<{
    bundle: WidgetBundle;
    widgetsCreated: number;
    widgetsSkipped: string[];
  }> {
    let title = dto.title?.trim();
    if (!title) {
      throw new BadRequestException('Imported bundle must have a title');
    }

    const existing = await this.widgetBundleRepository.findOne({
      where: { title },
    });

    if (existing) {
      if (!dto.allowDuplicateTitle) {
        throw new ConflictException(
          `A widget bundle titled "${title}" already exists. Re-send with allowDuplicateTitle=true to import it under a new title.`,
        );
      }

      // Find a free suffix rather than blindly appending "(1)" — repeated
      // imports would otherwise collide again on the second attempt.
      let suffix = 1;
      let candidate = `${title} (${suffix})`;
      while (
        await this.widgetBundleRepository.findOne({ where: { title: candidate } })
      ) {
        suffix += 1;
        candidate = `${title} (${suffix})`;
      }
      title = candidate;
    }

    const bundle = this.widgetBundleRepository.create({
      title,
      description: dto.description,
      image: dto.image,
      order: dto.order ?? 0,
      additionalInfo: dto.additionalInfo,
      // Imported bundles are never system bundles, whatever the payload claims —
      // otherwise an import could create something the UI refuses to delete.
      system: false,
    });

    const saved = await this.widgetBundleRepository.save(bundle);

    let widgetsCreated = 0;
    const widgetsSkipped: string[] = [];

    for (const widget of dto.widgets ?? []) {
      // Widget type names are globally unique in this schema. A clash is skipped
      // and reported rather than failing the whole import, so one stale widget
      // does not cost the user the other fourteen.
      const nameTaken = await this.widgetTypeRepository.findOne({
        where: { name: widget.name },
      });

      if (nameTaken) {
        widgetsSkipped.push(widget.name);
        continue;
      }

      const created = this.widgetTypeRepository.create({
        ...widget,
        category: widget.category as any,
        bundleFqn: saved.title,
      });
      await this.widgetTypeRepository.save(created);
      widgetsCreated++;
    }

    this.eventEmitter.emit('widget.bundle.imported', {
      bundleId: saved.id,
      widgetsCreated,
    });

    return { bundle: saved, widgetsCreated, widgetsSkipped };
  }

async getStatistics() {
  const total = await this.widgetBundleRepository.count();
  const system = await this.widgetBundleRepository.count({ where: { system: true } });
  const totalWidgets = await this.widgetTypeRepository.count({ where: { bundleFqn: Not(IsNull()) } });

  // Fix: use subquery instead of broken raw join
  const withWidgets = await this.widgetBundleRepository
    .createQueryBuilder('bundle')
    .where(qb => {
      const sub = qb.subQuery()
        .select('wt.bundleFqn')
        .from(WidgetType, 'wt')
        .where('wt.bundleFqn IS NOT NULL')
        .getQuery();
      return 'bundle.title IN ' + sub;
    })
    .getCount();

  return { total, system, custom: total - system, withWidgets, totalWidgets };
}
}