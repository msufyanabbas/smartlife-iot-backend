import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, TenantStatus } from './entities/tenant.entity';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async create(userId: string, createDto: CreateTenantDto): Promise<Tenant> {
    // Check if tenant with same name or email exists
    const existing = await this.tenantRepository.findOne({
      where: [{ name: createDto.name }, { email: createDto.email }],
    });

    if (existing) {
      throw new ConflictException(
        'Tenant with this name or email already exists',
      );
    }

    const tenant = this.tenantRepository.create({
      ...createDto,
      createdBy: userId,
      configuration: {
        maxDevices: 100,
        maxUsers: 10,
        maxAssets: 50,
        maxDashboards: 10,
        maxRuleChains: 5,
        dataRetentionDays: 30,
        features: [],
        ...createDto.configuration,
      },
    });

    return await this.tenantRepository.save(tenant);
  }

  async findAll(paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.tenantRepository.createQueryBuilder('tenant');

    if (search) {
      queryBuilder.where(
        '(tenant.name ILIKE :search OR tenant.title ILIKE :search OR tenant.email ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`tenant.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { id } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async findByName(name: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { name } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateTenantDto,
  ): Promise<Tenant> {
    const tenant = await this.findOne(id);

    // Check for name/email conflicts
    if (updateDto.name || updateDto.email) {
      const existing = await this.tenantRepository.findOne({
        where: [{ name: updateDto.name }, { email: updateDto.email }],
      });

      if (existing && existing.id !== id) {
        throw new ConflictException(
          'Tenant with this name or email already exists',
        );
      }
    }

    Object.assign(tenant, updateDto);
    tenant.updatedBy = userId;

    return await this.tenantRepository.save(tenant);
  }

  async remove(id: string): Promise<void> {
    const tenant = await this.findOne(id);
    await this.tenantRepository.softRemove(tenant);
  }

  async activate(id: string, userId: string): Promise<Tenant> {
    const tenant = await this.findOne(id);
    tenant.status = TenantStatus.ACTIVE;
    tenant.updatedBy = userId;
    return await this.tenantRepository.save(tenant);
  }

  async suspend(id: string, userId: string): Promise<Tenant> {
    const tenant = await this.findOne(id);
    tenant.status = TenantStatus.SUSPENDED;
    tenant.updatedBy = userId;
    return await this.tenantRepository.save(tenant);
  }

  async getStatistics() {
    const [total, active, inactive, suspended] = await Promise.all([
      this.tenantRepository.count(),
      this.tenantRepository.count({ where: { status: TenantStatus.ACTIVE } }),
      this.tenantRepository.count({ where: { status: TenantStatus.INACTIVE } }),
      this.tenantRepository.count({
        where: { status: TenantStatus.SUSPENDED },
      }),
    ]);

    return {
      total,
      active,
      inactive,
      suspended,
    };
  }

  async getUsage(id: string) {
    const tenant = await this.findOne(id);

    // TODO: Get actual usage from related tables
    // For now, return mock data
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      limits: tenant.configuration,
      usage: {
        devices: 0,
        users: 0,
        assets: 0,
        dashboards: 0,
        ruleChains: 0,
      },
    };
  }
}
