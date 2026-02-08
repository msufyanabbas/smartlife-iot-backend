import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission } from './entities/permissions.entity';
import { CreatePermissionDto, UpdatePermissionDto } from './dto';

@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
  ) {}

  /**
   * Create a new permission
   */
  async create(createPermissionDto: CreatePermissionDto): Promise<Permission> {
    // Check if permission already exists
    const existingPermission = await this.permissionRepository.findOne({
      where: {
        resource: createPermissionDto.resource,
        action: createPermissionDto.action,
      },
    });

    if (existingPermission) {
      throw new ConflictException(
        `Permission with resource '${createPermissionDto.resource}' and action '${createPermissionDto.action}' already exists`,
      );
    }

    const permission = this.permissionRepository.create(createPermissionDto);
    return await this.permissionRepository.save(permission);
  }

  /**
   * Get all permissions
   */
  async findAll(): Promise<Permission[]> {
    return await this.permissionRepository.find({
      order: {
        resource: 'ASC',
        action: 'ASC',
      },
    });
  }

  /**
   * Get permissions by resource
   */
  async findByResource(resource: string): Promise<Permission[]> {
    return await this.permissionRepository.find({
      where: { resource },
      order: { action: 'ASC' },
    });
  }

  /**
   * Get a single permission by ID
   */
  async findOne(id: string): Promise<Permission> {
    const permission = await this.permissionRepository.findOne({
      where: { id },
    });

    if (!permission) {
      throw new NotFoundException(`Permission with ID '${id}' not found`);
    }

    return permission;
  }

  /**
   * Find permission by resource and action
   */
  async findByResourceAndAction(
    resource: string,
    action: string,
  ): Promise<Permission> {
    const permission = await this.permissionRepository.findOne({
      where: { resource, action },
    });

    if (!permission) {
      throw new NotFoundException(
        `Permission '${resource}:${action}' not found`,
      );
    }

    return permission;
  }

  /**
   * Update a permission
   */
  async update(
    id: string,
    updatePermissionDto: UpdatePermissionDto,
  ): Promise<Permission> {
    const permission = await this.findOne(id);

    // If updating resource or action, check for conflicts
    if (updatePermissionDto.resource || updatePermissionDto.action) {
      const resource = updatePermissionDto.resource || permission.resource;
      const action = updatePermissionDto.action || permission.action;

      const existingPermission = await this.permissionRepository.findOne({
        where: { resource, action },
      });

      if (existingPermission && existingPermission.id !== id) {
        throw new ConflictException(
          `Permission with resource '${resource}' and action '${action}' already exists`,
        );
      }
    }

    Object.assign(permission, updatePermissionDto);
    return await this.permissionRepository.save(permission);
  }

  /**
   * Delete a permission
   */
  async remove(id: string): Promise<void> {
    const permission = await this.findOne(id);

    if (permission.isSystem) {
      throw new BadRequestException(
        'Cannot delete system permissions. Set isSystem to false first.',
      );
    }

    await this.permissionRepository.remove(permission);
  }

  /**
   * Soft delete a permission (if using soft deletes)
   */
  async softRemove(id: string): Promise<Permission> {
    const permission = await this.findOne(id);

    if (permission.isSystem) {
      throw new BadRequestException(
        'Cannot delete system permissions. Set isSystem to false first.',
      );
    }

    return await this.permissionRepository.softRemove(permission);
  }

  /**
   * Get all unique resources
   */
  async getUniqueResources(): Promise<string[]> {
    const result = await this.permissionRepository
      .createQueryBuilder('permission')
      .select('DISTINCT permission.resource', 'resource')
      .orderBy('permission.resource', 'ASC')
      .getRawMany();

    return result.map((r) => r.resource);
  }

  /**
   * Bulk create permissions
   */
  async bulkCreate(
    createPermissionDtos: CreatePermissionDto[],
  ): Promise<Permission[]> {
    const permissions = createPermissionDtos.map((dto) =>
      this.permissionRepository.create(dto),
    );

    try {
      return await this.permissionRepository.save(permissions);
    } catch (error) {
      throw new ConflictException(
        'One or more permissions already exist with the same resource and action combination',
      );
    }
  }
}