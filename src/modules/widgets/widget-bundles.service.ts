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
import {
  CreateWidgetBundleDto,
  UpdateWidgetBundleDto,
  QueryWidgetBundlesDto,
} from './dto/widgets.dto';

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

  async findAll(queryDto: QueryWidgetBundlesDto): Promise<{
    bundles: WidgetBundle[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
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

    return { bundles, total, page, limit, totalPages: Math.ceil(total / limit) };
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