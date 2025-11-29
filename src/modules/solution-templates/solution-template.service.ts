import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SolutionTemplate,
  TemplateCategory,
} from './entities/solution-template.entity';
import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';

@Injectable()
export class SolutionTemplatesService {
  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly templateRepository: Repository<SolutionTemplate>,
  ) {}

  async create(
    userId: string,
    createDto: CreateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    const template = this.templateRepository.create({
      ...createDto,
      userId,
      createdBy: userId,
      isSystem: false, // User-created templates
      rating: 0,
      installs: 0,
    });

    return await this.templateRepository.save(template);
  }

  async findAll(filters?: FindAllTemplatesDto) {
    const { page = 1, limit = 12, search, category, isPremium } = filters || {};
    const skip = (page - 1) * limit;

    const queryBuilder = this.templateRepository.createQueryBuilder('template');

    if (category) {
      queryBuilder.andWhere('template.category = :category', { category });
    }

    if (isPremium !== undefined) {
      queryBuilder.andWhere('template.isPremium = :isPremium', { isPremium });
    }

    if (search) {
      queryBuilder.andWhere(
        '(template.name ILIKE :search OR template.description ILIKE :search OR :search = ANY(template.tags))',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy('template.installs', 'DESC')
      .addOrderBy('template.rating', 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<SolutionTemplate> {
    const template = await this.templateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException('Solution template not found');
    }

    return template;
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    const template = await this.findOne(id);

    // Only allow updating user-created templates
    if (template.isSystem) {
      throw new ForbiddenException('Cannot update system templates');
    }

    if (template.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to update this template',
      );
    }

    Object.assign(template, updateDto);
    template.updatedBy = userId;
    template.lastUpdated = new Date();

    return await this.templateRepository.save(template);
  }

  async remove(id: string, userId: string): Promise<void> {
    const template = await this.findOne(id);

    if (template.isSystem) {
      throw new ForbiddenException('Cannot delete system templates');
    }

    if (template.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this template',
      );
    }

    await this.templateRepository.softRemove(template);
  }

  async install(
    id: string,
    userId: string,
    installDto: InstallTemplateDto,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    const template = await this.findOne(id);

    // Increment install count
    template.installs += 1;
    await this.templateRepository.save(template);

    // TODO: Implement actual installation logic
    // This would create devices, dashboards, rules, etc. based on the template configuration

    return {
      success: true,
      message: `Template "${template.name}" installed successfully`,
      data: {
        templateId: template.id,
        templateName: template.name,
        installationName: installDto.installationName || template.name,
        devicesCreated: template.devices,
        dashboardsCreated: template.dashboards,
        rulesCreated: template.rules,
      },
    };
  }

  async getCategories(): Promise<
    { category: string; name: string; icon: string; count: number }[]
  > {
    const categoryCounts = await this.templateRepository
      .createQueryBuilder('template')
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category')
      .getRawMany();

    const categoryMap = categoryCounts.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const categories = [
      {
        category: TemplateCategory.SMART_FACTORY,
        name: 'Smart Factory',
        icon: 'factory',
      },
      {
        category: TemplateCategory.SMART_HOME,
        name: 'Smart Home',
        icon: 'home',
      },
      {
        category: TemplateCategory.SMART_BUILDING,
        name: 'Smart Building',
        icon: 'building',
      },
      {
        category: TemplateCategory.SMART_CITY,
        name: 'Smart City',
        icon: 'city',
      },
      {
        category: TemplateCategory.AGRICULTURE,
        name: 'Agriculture',
        icon: 'plant',
      },
      {
        category: TemplateCategory.HEALTHCARE,
        name: 'Healthcare',
        icon: 'hospital',
      },
      { category: TemplateCategory.ENERGY, name: 'Energy', icon: 'battery' },
      {
        category: TemplateCategory.LOGISTICS,
        name: 'Logistics',
        icon: 'truck',
      },
      {
        category: TemplateCategory.RETAIL,
        name: 'Retail',
        icon: 'shopping-cart',
      },
      {
        category: TemplateCategory.WATER,
        name: 'Water Management',
        icon: 'droplet',
      },
      {
        category: TemplateCategory.CLIMATE,
        name: 'Climate Control',
        icon: 'thermometer',
      },
      {
        category: TemplateCategory.EDUCATION,
        name: 'Education',
        icon: 'graduation-cap',
      },
    ];

    return categories.map((cat) => ({
      ...cat,
      count: categoryMap[cat.category] || 0,
    }));
  }

  async getStatistics() {
    const [total, premium, systemTemplates, totalInstalls] = await Promise.all([
      this.templateRepository.count(),
      this.templateRepository.count({ where: { isPremium: true } }),
      this.templateRepository.count({ where: { isSystem: true } }),
      this.templateRepository
        .createQueryBuilder('template')
        .select('SUM(template.installs)', 'total')
        .getRawOne(),
    ]);

    const byCategoryResult = await this.templateRepository
      .createQueryBuilder('template')
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category')
      .getRawMany();

    const byCategory = byCategoryResult.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const popular = await this.templateRepository.find({
      order: { installs: 'DESC', rating: 'DESC' },
      take: 5,
    });

    return {
      total,
      premium,
      free: total - premium,
      systemTemplates,
      userTemplates: total - systemTemplates,
      totalInstalls: parseInt(totalInstalls?.total || '0'),
      byCategory,
      popular: popular.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        installs: t.installs,
        rating: t.rating,
      })),
    };
  }

  async rateTemplate(
    id: string,
    userId: string,
    rating: number,
  ): Promise<SolutionTemplate> {
    const template = await this.findOne(id);

    // TODO: Implement proper rating system with user ratings tracking
    // For now, update the average rating
    template.rating = rating;
    template.updatedBy = userId;

    return await this.templateRepository.save(template);
  }
}
