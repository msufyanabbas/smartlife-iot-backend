import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
    private widgetBundleRepository: Repository<WidgetBundle>,
    @InjectRepository(WidgetType)
    private widgetTypeRepository: Repository<WidgetType>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new widget bundle
   */
  async create(createDto: CreateWidgetBundleDto): Promise<WidgetBundle> {
    // Check if title already exists
    const existing = await this.widgetBundleRepository.findOne({
      where: { title: createDto.title },
    });

    if (existing) {
      throw new ConflictException(
        'Widget bundle with this title already exists',
      );
    }

    const bundle = this.widgetBundleRepository.create(createDto);
    const savedBundle = await this.widgetBundleRepository.save(bundle);

    // Emit event
    this.eventEmitter.emit('widget.bundle.created', { bundle: savedBundle });

    return savedBundle;
  }

  /**
   * Find all widget bundles with filters
   */
  async findAll(queryDto: QueryWidgetBundlesDto): Promise<{
    bundles: WidgetBundle[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder =
      this.widgetBundleRepository.createQueryBuilder('bundle');

    // Apply filters
    if (queryDto.search) {
      queryBuilder.andWhere(
        '(bundle.title ILIKE :search OR bundle.description ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    if (queryDto.tenantId) {
      queryBuilder.andWhere('bundle.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

    if (queryDto.system !== undefined) {
      queryBuilder.andWhere('bundle.system = :system', {
        system: queryDto.system,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const bundles = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('bundle.order', 'ASC')
      .addOrderBy('bundle.title', 'ASC')
      .getMany();

    return {
      bundles,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find one widget bundle by ID
   */
  async findOne(id: string): Promise<WidgetBundle> {
    const bundle = await this.widgetBundleRepository.findOne({
      where: { id },
    });

    if (!bundle) {
      throw new NotFoundException('Widget bundle not found');
    }

    return bundle;
  }

  /**
   * Update widget bundle
   */
  async update(
    id: string,
    updateDto: UpdateWidgetBundleDto,
  ): Promise<WidgetBundle> {
    const bundle = await this.findOne(id);

    // Prevent updating system bundles
    if (bundle.system) {
      throw new BadRequestException('Cannot update system widget bundles');
    }

    // Check if title is being changed and if it already exists
    if (updateDto.title && updateDto.title !== bundle.title) {
      const existing = await this.widgetBundleRepository.findOne({
        where: { title: updateDto.title },
      });

      if (existing) {
        throw new ConflictException(
          'Widget bundle with this title already exists',
        );
      }
    }

    Object.assign(bundle, updateDto);
    const updatedBundle = await this.widgetBundleRepository.save(bundle);

    // Emit event
    this.eventEmitter.emit('widget.bundle.updated', { bundle: updatedBundle });

    return updatedBundle;
  }

  /**
   * Delete widget bundle
   */
  async remove(id: string): Promise<void> {
    const bundle = await this.findOne(id);

    // Prevent deleting system bundles
    if (bundle.system) {
      throw new BadRequestException('Cannot delete system widget bundles');
    }

    // Check if bundle has widgets
    const widgetsCount = await this.widgetTypeRepository.count({
      where: { bundleFqn: bundle.title },
    });

    if (widgetsCount > 0) {
      throw new BadRequestException(
        `Cannot delete bundle. ${widgetsCount} widget(s) are in this bundle.`,
      );
    }

    await this.widgetBundleRepository.softRemove(bundle);

    // Emit event
    this.eventEmitter.emit('widget.bundle.deleted', { bundleId: id });
  }

  /**
   * Get widgets in bundle
   */
  async getWidgetsInBundle(id: string): Promise<WidgetType[]> {
    const bundle = await this.findOne(id);

    return await this.widgetTypeRepository.find({
      where: { bundleFqn: bundle.title },
      order: { name: 'ASC' },
    });
  }

  /**
   * Add widget to bundle
   */
  async addWidgetToBundle(
    bundleId: string,
    widgetTypeId: string,
  ): Promise<void> {
    const bundle = await this.findOne(bundleId);

    const widgetType = await this.widgetTypeRepository.findOne({
      where: { id: widgetTypeId },
    });

    if (!widgetType) {
      throw new NotFoundException('Widget type not found');
    }

    widgetType.bundleFqn = bundle.title;
    await this.widgetTypeRepository.save(widgetType);

    // Emit event
    this.eventEmitter.emit('widget.bundle.widget.added', {
      bundleId,
      widgetTypeId,
    });
  }

  /**
   * Remove widget from bundle
   */
  async removeWidgetFromBundle(
    bundleId: string,
    widgetTypeId: string,
  ): Promise<void> {
    await this.findOne(bundleId); // Ensure bundle exists

    const widgetType: WidgetType | null =
      await this.widgetTypeRepository.findOne({
        where: { id: widgetTypeId },
      });

    if (!widgetType) {
      throw new NotFoundException('Widget type not found');
    }

    widgetType.bundleFqn = '';
    await this.widgetTypeRepository.save(widgetType);

    // Emit event
    this.eventEmitter.emit('widget.bundle.widget.removed', {
      bundleId,
      widgetTypeId,
    });
  }

  /**
   * Get bundle statistics
   */
  async getStatistics(): Promise<{
    total: number;
    system: number;
    custom: number;
    withWidgets: number;
    totalWidgets: number;
  }> {
    const total = await this.widgetBundleRepository.count();
    const system = await this.widgetBundleRepository.count({
      where: { system: true },
    });
    const custom = total - system;

    // Count bundles with widgets
    const bundlesWithWidgets = await this.widgetBundleRepository
      .createQueryBuilder('bundle')
      .leftJoin('widget_types', 'widget', 'widget.bundleFqn = bundle.title')
      .where('widget.id IS NOT NULL')
      .select('COUNT(DISTINCT bundle.id)', 'count')
      .getRawOne();

    const withWidgets = parseInt(bundlesWithWidgets.count) || 0;

    // Total widgets in bundles
    const totalWidgets: number = await this.widgetTypeRepository.count({
      where: { bundleFqn: IsNull() },
    });

    return {
      total,
      system,
      custom,
      withWidgets,
      totalWidgets: (await this.widgetTypeRepository.count()) - totalWidgets,
    };
  }
}
