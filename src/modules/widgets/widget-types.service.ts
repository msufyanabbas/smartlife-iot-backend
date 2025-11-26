import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WidgetType, WidgetTypeCategory } from './entities/widget-type.entity';
import {
  CreateWidgetTypeDto,
  UpdateWidgetTypeDto,
  QueryWidgetTypesDto,
} from './dto/widgets.dto';

@Injectable()
export class WidgetTypesService {
  constructor(
    @InjectRepository(WidgetType)
    private widgetTypeRepository: Repository<WidgetType>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new widget type
   */
  async create(createDto: CreateWidgetTypeDto): Promise<WidgetType> {
    // Check if name already exists
    const existing = await this.widgetTypeRepository.findOne({
      where: { name: createDto.name },
    });

    if (existing) {
      throw new ConflictException('Widget type with this name already exists');
    }

    // Validate descriptor
    this.validateDescriptor(createDto.descriptor);

    const widgetType = this.widgetTypeRepository.create(createDto);
    const savedWidget = await this.widgetTypeRepository.save(widgetType);

    // Emit event
    this.eventEmitter.emit('widget.type.created', { widgetType: savedWidget });

    return savedWidget;
  }

  /**
   * Find all widget types with filters
   */
  async findAll(queryDto: QueryWidgetTypesDto): Promise<{
    widgetTypes: WidgetType[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.widgetTypeRepository.createQueryBuilder('widget');

    // Apply filters
    if (queryDto.search) {
      queryBuilder.andWhere(
        '(widget.name ILIKE :search OR widget.description ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    if (queryDto.category) {
      queryBuilder.andWhere('widget.category = :category', {
        category: queryDto.category,
      });
    }

    if (queryDto.bundleFqn) {
      queryBuilder.andWhere('widget.bundleFqn = :bundleFqn', {
        bundleFqn: queryDto.bundleFqn,
      });
    }

    if (queryDto.tenantId) {
      queryBuilder.andWhere('widget.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

    if (queryDto.system !== undefined) {
      queryBuilder.andWhere('widget.system = :system', {
        system: queryDto.system,
      });
    }

    if (queryDto.tags && queryDto.tags.length > 0) {
      queryBuilder.andWhere('widget.tags && :tags', { tags: queryDto.tags });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const widgetTypes = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('widget.createdAt', 'DESC')
      .getMany();

    return {
      widgetTypes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find widget types by category
   */
  async findByCategory(category: WidgetTypeCategory): Promise<WidgetType[]> {
    return await this.widgetTypeRepository.find({
      where: { category },
      order: { name: 'ASC' },
    });
  }

  /**
   * Find widget types by bundle
   */
  async findByBundle(bundleFqn: string): Promise<WidgetType[]> {
    return await this.widgetTypeRepository.find({
      where: { bundleFqn },
      order: { name: 'ASC' },
    });
  }

  /**
   * Find one widget type by ID
   */
  async findOne(id: string): Promise<WidgetType> {
    const widgetType = await this.widgetTypeRepository.findOne({
      where: { id },
    });

    if (!widgetType) {
      throw new NotFoundException('Widget type not found');
    }

    return widgetType;
  }

  /**
   * Update widget type
   */
  async update(
    id: string,
    updateDto: UpdateWidgetTypeDto,
  ): Promise<WidgetType> {
    const widgetType = await this.findOne(id);

    // Prevent updating system widgets
    if (widgetType.system) {
      throw new BadRequestException('Cannot update system widget types');
    }

    // Check if name is being changed and if it already exists
    if (updateDto.name && updateDto.name !== widgetType.name) {
      const existing = await this.widgetTypeRepository.findOne({
        where: { name: updateDto.name },
      });

      if (existing) {
        throw new ConflictException(
          'Widget type with this name already exists',
        );
      }
    }

    // Validate descriptor if provided
    if (updateDto.descriptor) {
      this.validateDescriptor(updateDto.descriptor);
    }

    Object.assign(widgetType, updateDto);
    const updatedWidget = await this.widgetTypeRepository.save(widgetType);

    // Emit event
    this.eventEmitter.emit('widget.type.updated', {
      widgetType: updatedWidget,
    });

    return updatedWidget;
  }

  /**
   * Delete widget type
   */
  async remove(id: string): Promise<void> {
    const widgetType = await this.findOne(id);

    // Prevent deleting system widgets
    if (widgetType.system) {
      throw new BadRequestException('Cannot delete system widget types');
    }

    await this.widgetTypeRepository.softRemove(widgetType);

    // Emit event
    this.eventEmitter.emit('widget.type.deleted', { widgetTypeId: id });
  }

  /**
   * Clone widget type
   */
  async clone(id: string, newName: string): Promise<WidgetType> {
    const original = await this.findOne(id);

    // Check if new name already exists
    const existing = await this.widgetTypeRepository.findOne({
      where: { name: newName },
    });

    if (existing) {
      throw new ConflictException('Widget type with this name already exists');
    }

    // Create new widget type based on original
    const cloned = this.widgetTypeRepository.create({
      ...original,
      id: undefined, // Remove ID
      name: newName,
      system: false, // Clone is not system
      createdAt: undefined,
      updatedAt: undefined,
    });

    return await this.widgetTypeRepository.save(cloned);
  }

  /**
   * Import widget type from JSON
   */
  async importWidget(widgetData: any): Promise<WidgetType> {
    // Validate required fields
    if (!widgetData.name || !widgetData.descriptor) {
      throw new BadRequestException(
        'Invalid widget data: missing name or descriptor',
      );
    }

    // Check if name already exists
    const existing = await this.widgetTypeRepository.findOne({
      where: { name: widgetData.name },
    });

    if (existing) {
      throw new ConflictException('Widget type with this name already exists');
    }

    // Validate descriptor
    this.validateDescriptor(widgetData.descriptor);

    // Create widget type
    const widgetType = this.widgetTypeRepository.create({
      name: widgetData.name,
      description: widgetData.description,
      category: widgetData.category || WidgetTypeCategory.OTHER,
      bundleFqn: widgetData.bundleFqn,
      image: widgetData.image,
      iconUrl: widgetData.iconUrl,
      descriptor: widgetData.descriptor,
      settingsTemplate: widgetData.settingsTemplate,
      tags: widgetData.tags,
      system: false, // Imported widgets are not system
      additionalInfo: widgetData.additionalInfo,
    });

    return await this.widgetTypeRepository.save(widgetType);
  }

  /**
   * Export widget type to JSON
   */
  async exportWidget(id: string): Promise<any> {
    const widgetType = await this.findOne(id);

    return {
      name: widgetType.name,
      description: widgetType.description,
      category: widgetType.category,
      bundleFqn: widgetType.bundleFqn,
      image: widgetType.image,
      iconUrl: widgetType.iconUrl,
      descriptor: widgetType.descriptor,
      settingsTemplate: widgetType.settingsTemplate,
      tags: widgetType.tags,
      additionalInfo: widgetType.additionalInfo,
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };
  }

  /**
   * Get widget type statistics
   */
  async getStatistics(): Promise<{
    total: number;
    byCategory: Record<WidgetTypeCategory, number>;
    system: number;
    custom: number;
    byBundle: Array<{ bundleFqn: string; count: number }>;
  }> {
    const total = await this.widgetTypeRepository.count();
    const system = await this.widgetTypeRepository.count({
      where: { system: true },
    });
    const custom = total - system;

    // Count by category
    const categories = await this.widgetTypeRepository
      .createQueryBuilder('widget')
      .select('widget.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('widget.category')
      .getRawMany();

    const byCategory: any = {};
    Object.values(WidgetTypeCategory).forEach((cat) => {
      byCategory[cat] = 0;
    });

    categories.forEach((row) => {
      byCategory[row.category] = parseInt(row.count);
    });

    // Count by bundle
    const bundles = await this.widgetTypeRepository
      .createQueryBuilder('widget')
      .select('widget.bundleFqn', 'bundleFqn')
      .addSelect('COUNT(*)', 'count')
      .where('widget.bundleFqn IS NOT NULL')
      .groupBy('widget.bundleFqn')
      .getRawMany();

    const byBundle = bundles.map((row) => ({
      bundleFqn: row.bundleFqn,
      count: parseInt(row.count),
    }));

    return {
      total,
      byCategory,
      system,
      custom,
      byBundle,
    };
  }

  /**
   * Validate widget descriptor
   */
  private validateDescriptor(descriptor: any): void {
    if (!descriptor.type) {
      throw new BadRequestException('Descriptor must have a type');
    }

    const validTypes = ['timeseries', 'latest', 'rpc', 'alarm', 'static'];
    if (!validTypes.includes(descriptor.type)) {
      throw new BadRequestException(
        `Invalid descriptor type: ${descriptor.type}`,
      );
    }

    if (!descriptor.sizeX || !descriptor.sizeY) {
      throw new BadRequestException('Descriptor must have sizeX and sizeY');
    }

    // Validate template HTML if provided
    if (descriptor.templateHtml) {
      // Basic validation - check for script tags (security)
      if (
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi.test(
          descriptor.templateHtml,
        )
      ) {
        throw new BadRequestException(
          'Template HTML cannot contain script tags',
        );
      }
    }
  }
}
