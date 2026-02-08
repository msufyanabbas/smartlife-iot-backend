import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, IsNull } from 'typeorm';
import { Role } from './entities/roles.entity';
import { Permission } from '@/modules/permissions/entities/permissions.entity';
import { Tenant } from '@/modules/tenants/entities/tenant.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { QueryRoleDto } from './dto/query-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { User } from '../index.entities';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async create(createRoleDto: CreateRoleDto): Promise<Role> {
    const { permissionIds, tenantId, ...roleData } = createRoleDto;

    // Check if role name already exists for this tenant/system
    const existingRole = await this.roleRepository.findOne({
      where: {
        name: roleData.name,
        tenantId: tenantId || IsNull(),
      },
    });

    if (existingRole) {
      throw new ConflictException(
        `Role with name "${roleData.name}" already exists${tenantId ? ' for this tenant' : ' as a system role'}`
      );
    }

    // Validate tenant if provided
    if (tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID ${tenantId} not found`);
      }
    }

    // Create role
    const role = this.roleRepository.create({
      ...roleData,
      tenantId,
    });

    // Assign permissions if provided
    if (permissionIds && permissionIds.length > 0) {
      const permissions = await this.permissionRepository.findByIds(permissionIds);
      if (permissions.length !== permissionIds.length) {
        throw new BadRequestException('One or more permission IDs are invalid');
      }
      role.permissions = permissions;
    }

    return this.roleRepository.save(role);
  }

  async findAll(queryDto: QueryRoleDto) {
    const { search, tenantId, isSystem, page, limit, sortBy, sortOrder } = queryDto as any;

    const queryBuilder = this.roleRepository
      .createQueryBuilder('role')
      .leftJoinAndSelect('role.permissions', 'permissions')
      .leftJoinAndSelect('role.tenant', 'tenant');

    // Search filter
    if (search) {
      queryBuilder.andWhere(
        '(role.name ILIKE :search OR role.description ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    // Tenant filter
    if (tenantId !== undefined) {
      if (tenantId === null || tenantId === 'null') {
        queryBuilder.andWhere('role.tenantId IS NULL');
      } else {
        queryBuilder.andWhere('role.tenantId = :tenantId', { tenantId });
      }
    }

    // System role filter
    if (isSystem !== undefined) {
      queryBuilder.andWhere('role.isSystem = :isSystem', { isSystem });
    }

    // Sorting
    queryBuilder.orderBy(`role.${sortBy}`, sortOrder);

    // Pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { id },
      relations: ['permissions', 'tenant', 'users'],
    });

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    return role;
  }

  async findByName(name: string, tenantId?: string): Promise<Role | null> {
    return this.roleRepository.findOne({
      where: {
        name,
        tenantId: tenantId || IsNull(),
      },
      relations: ['permissions'],
    });
  }

  async update(id: string, updateRoleDto: UpdateRoleDto): Promise<Role> {
    const role = await this.findOne(id);

    // Prevent updating system roles
    if (role.isSystem && updateRoleDto.name) {
      throw new BadRequestException('Cannot modify system role name');
    }

    const { permissionIds, tenantId, ...roleData } = updateRoleDto;

    // Check for name conflicts if name is being updated
    if (roleData.name && roleData.name !== role.name) {
      const existingRole = await this.roleRepository.findOne({
        where: {
          name: roleData.name,
          tenantId: tenantId || role.tenantId || IsNull(),
        },
      });

      if (existingRole && existingRole.id !== id) {
        throw new ConflictException(
          `Role with name "${roleData.name}" already exists`
        );
      }
    }

    // Validate tenant if provided
    if (tenantId && tenantId !== role.tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID ${tenantId} not found`);
      }
    }

    // Update permissions if provided
    if (permissionIds !== undefined) {
      if (permissionIds.length === 0) {
        role.permissions = [];
      } else {
        const permissions = await this.permissionRepository.findByIds(permissionIds);
        if (permissions.length !== permissionIds.length) {
          throw new BadRequestException('One or more permission IDs are invalid');
        }
        role.permissions = permissions;
      }
    }

    // Update role data
    Object.assign(role, roleData);
    if (tenantId !== undefined) {
      role.tenantId = tenantId;
    }

    return this.roleRepository.save(role);
  }

  async remove(id: string): Promise<void> {
    const role = await this.findOne(id);

    // Prevent deleting system roles
    if (role.isSystem) {
      throw new BadRequestException('Cannot delete system roles');
    }

    // Check if role has users
    if (role.users && role.users.length > 0) {
      throw new BadRequestException(
        `Cannot delete role "${role.name}" as it is assigned to ${role.users.length} user(s)`
      );
    }

    await this.roleRepository.remove(role);
  }

  async assignPermissions(id: string, assignPermissionsDto: AssignPermissionsDto): Promise<Role> {
    const role = await this.findOne(id);
    const { permissionIds } = assignPermissionsDto;

    const permissions = await this.permissionRepository.findByIds(permissionIds);
    
    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('One or more permission IDs are invalid');
    }

    role.permissions = permissions;
    return this.roleRepository.save(role);
  }

  async removePermissions(id: string, permissionIds: string[]): Promise<Role> {
    const role = await this.findOne(id);

    if (!role.permissions) {
      return role;
    }

    role.permissions = role.permissions.filter(
      permission => !permissionIds.includes(permission.id)
    );

    return this.roleRepository.save(role);
  }

  async getSystemRoles(): Promise<Role[]> {
    return this.roleRepository.find({
      where: { isSystem: true },
      relations: ['permissions'],
    });
  }

  async getTenantRoles(tenantId: string): Promise<Role[]> {
    return this.roleRepository.find({
      where: { tenantId },
      relations: ['permissions'],
    });
  }

  async getUsersCount(id: string): Promise<{ count: number; users: User[] }> {
  const role = await this.roleRepository
    .createQueryBuilder('role')
    .leftJoinAndSelect('role.users', 'users')
    .where('role.id = :id', { id })
    .getOne();

  if (!role) {
    throw new NotFoundException(`Role with ID ${id} not found`);
  }

  return {
    count: role.users?.length || 0,
    users: role.users || []
  };
}
}