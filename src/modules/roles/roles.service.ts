import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { UserRole } from '@common/enums/index.enum';

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

  async create(createRoleDto: CreateRoleDto, user: User): Promise<Role> {
    const { permissionIds, ...roleData } = createRoleDto;

    // Check if role name already exists for this tenant/system
    const existingRole = await this.roleRepository.findOne({
      where: {
        name: roleData.name,
        tenantId: user.tenantId || IsNull(),
      },
    });

    if (existingRole) {
      throw new ConflictException(
        `Role with name "${roleData.name}" already exists${user.tenantId ? ' for this tenant' : ' as a system role'}`
      );
    }

    // Validate tenant if provided
    if (user.tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID ${user.tenantId} not found`);
      }
    }

    // Create role.
    //
    // `isSystem` is forced, never taken from the body. CreateRoleDto exposes it
    // and the `...roleData` spread used to carry it straight through, so a tenant
    // admin could post `{"isSystem": true}` and create a role that:
    //   · every OTHER tenant then sees — findAll's predicate is
    //     `(role.isSystem = true OR role.tenantId = :tenantId)`, and it joins
    //     permissions, so the role's name and full permission set leaked
    //     cross-tenant;
    //   · GET /roles/system hands to everyone;
    //   · its own creator can then neither edit (assertCallerMayModify → 403) nor
    //     delete ("Cannot delete system roles") — permanently stuck.
    //
    // Only a SUPER_ADMIN may mint a platform-wide role.
    const isSystem =
      user.role === UserRole.SUPER_ADMIN ? Boolean(roleData.isSystem) : false;

    const role = this.roleRepository.create({
      ...roleData,
      isSystem,
      tenantId: user.tenantId,
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

async findAll(queryDto: QueryRoleDto, user: User) {
  const { search, isSystem, page, limit, sortBy, sortOrder } = queryDto as any;

  // ── Base filter builder (reused for all 3 queries) ─────────────────────────
 const applyBaseFilters = (qb: ReturnType<typeof this.roleRepository.createQueryBuilder>) => {
  // Always scope to: system roles OR tenant's own roles
  if (user.tenantId) {
    qb.andWhere(
      '(role.isSystem = true OR role.tenantId = :tenantId)',
      { tenantId: user.tenantId },
    );
  } else {
    // Super admin — still only show system roles + unscoped roles
    // remove this else block if super admin should see everything
    qb.andWhere('role.isSystem = true');
  }

  if (search) {
    qb.andWhere(
      '(role.name ILIKE :search OR role.description ILIKE :search)',
      { search: `%${search}%` },
    );
  }

  // isSystem filter applied ON TOP of the tenant scope above
  if (isSystem !== undefined) {
    qb.andWhere('role.isSystem = :isSystem', { isSystem });
  }

  return qb;
};

  // ── 1. Main query (paginated data + total) ─────────────────────────────────
  const mainQuery = applyBaseFilters(
    this.roleRepository
      .createQueryBuilder('role')
      .leftJoinAndSelect('role.permissions', 'permissions')
      .leftJoinAndSelect('role.tenant', 'tenant'),
  )
    .orderBy(`role.${sortBy}`, sortOrder)
    .skip((page - 1) * limit)
    .take(limit);

  // ── 2. System roles count ──────────────────────────────────────────────────
  const systemCountQuery = applyBaseFilters(
    this.roleRepository.createQueryBuilder('role'),
  ).andWhere('role.isSystem = true');

  // ── 3. Custom roles count ──────────────────────────────────────────────────
  const customCountQuery = applyBaseFilters(
    this.roleRepository.createQueryBuilder('role'),
  ).andWhere('role.isSystem = false');

  // ── Run all 3 in parallel ──────────────────────────────────────────────────
  const [[data, total], systemRoles, customRoles] = await Promise.all([
    mainQuery.getManyAndCount(),
    systemCountQuery.getCount(),
    customCountQuery.getCount(),
  ]);

  // Standard { data, meta } wrapper. The systemRoles / customRoles breakdown is
  // carried alongside it rather than dropped — those are whole-collection counts,
  // not page-scoped metadata, so they do not belong in PaginationMetaDto.
  return Object.assign(
    PaginatedResponseDto.create(data, page, limit, total),
    { systemRoles, customRoles },
  );
}

  /**
   * Fetch one role, scoped to what the caller may see.
   *
   * SECURITY: this used to be `where: { id }` with no tenant predicate and no
   * caller argument, and `update()`, `remove()`, `assignPermissions()` and
   * `removePermissions()` all went through it. So tenant A's admin could read AND
   * rewrite tenant B's roles by id — `findAll()` is tenant-scoped so the ids were
   * not listed, but `getSystemRoles()` hands out system-role ids, and an id from
   * any other source worked just as well.
   *
   * Scoping rules:
   *   · SUPER_ADMIN            — any role.
   *   · everyone else          — their own tenant's roles, plus system roles
   *                              (tenantId IS NULL), which every tenant uses.
   *
   * `caller` is optional so internal callers (seeders, other services) keep
   * working unscoped; every route passes it.
   */
  async findOne(id: string, caller?: User): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { id },
      relations: ['permissions', 'tenant', 'users'],
    });

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    this.assertCallerMaySee(role, caller);

    return role;
  }

  /**
   * Not-found rather than forbidden on a cross-tenant id: telling a caller
   * "that role exists but is not yours" confirms the id, which is the one bit
   * they should not get.
   */
  private assertCallerMaySee(role: Role, caller?: User): void {
    if (!caller) return;
    if (caller.role === UserRole.SUPER_ADMIN) return;

    // System roles (tenantId null) are shared platform-wide and readable by all.
    if (!role.tenantId) return;

    if (role.tenantId !== caller.tenantId) {
      throw new NotFoundException(`Role with ID ${role.id} not found`);
    }
  }

  /**
   * System roles are platform-wide: the same row backs every tenant. Letting one
   * tenant rewrite them changes what every other tenant's users can do, so no
   * tenant admin may touch them — only a SUPER_ADMIN.
   *
   * The previous guard was `if (role.isSystem && updateRoleDto.name)`: it blocked
   * renaming a system role but happily accepted a full `permissionIds` replace on
   * it, including on "Super Administrator".
   */
  private assertCallerMayModify(role: Role, caller?: User): void {
    if (!caller) return;
    this.assertCallerMaySee(role, caller);

    if (role.isSystem && caller.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        `"${role.name}" is a built-in platform role and cannot be modified. ` +
          'Create a custom role instead.',
      );
    }
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

  async update(
    id: string,
    updateRoleDto: UpdateRoleDto,
    caller?: User,
  ): Promise<Role> {
    const role = await this.findOne(id, caller);

    // Covers name AND permissionIds. The old check only blocked a rename.
    this.assertCallerMayModify(role, caller);

    const { permissionIds, tenantId, ...roleData } = updateRoleDto;

    // A tenant admin must not be able to move a role into another tenant, which
    // `tenantId` in the body would otherwise allow.
    if (
      caller &&
      caller.role !== UserRole.SUPER_ADMIN &&
      tenantId !== undefined &&
      tenantId !== caller.tenantId
    ) {
      throw new ForbiddenException(
        'You cannot reassign a role to a different tenant',
      );
    }

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

    // Update role data.
    //
    // `isSystem` is stripped for everyone but a SUPER_ADMIN. assertCallerMayModify
    // inspects the role's state BEFORE the update, so without this a tenant admin
    // could flip their own role to isSystem:true — publishing it to every tenant
    // and locking themselves out of it in the same request.
    if (
      roleData.isSystem !== undefined &&
      caller &&
      caller.role !== UserRole.SUPER_ADMIN
    ) {
      delete roleData.isSystem;
    }

    Object.assign(role, roleData);
    if (tenantId !== undefined) {
      role.tenantId = tenantId;
    }

    return this.roleRepository.save(role);
  }

  async remove(id: string, caller?: User): Promise<void> {
    const role = await this.findOne(id, caller);

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

  async assignPermissions(
    id: string,
    assignPermissionsDto: AssignPermissionsDto,
    caller?: User,
  ): Promise<Role> {
    const role = await this.findOne(id, caller);
    this.assertCallerMayModify(role, caller);
    const { permissionIds } = assignPermissionsDto;

    const permissions = await this.permissionRepository.findByIds(permissionIds);
    
    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('One or more permission IDs are invalid');
    }

    role.permissions = permissions;
    return this.roleRepository.save(role);
  }

  async removePermissions(
    id: string,
    permissionIds: string[],
    caller?: User,
  ): Promise<Role> {
    const role = await this.findOne(id, caller);
    this.assertCallerMayModify(role, caller);

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

  /**
   * Users holding this role.
   *
   * SECURITY: this resolved a bare id globally — `where role.id = :id` with no
   * tenant predicate — while `leftJoinAndSelect('role.users')` returns full User
   * rows. So tenant A's admin could call
   * `GET /roles/<a tenant-B role id>/users` and read tenant B's users' names,
   * emails and phone numbers. (Only `password` is `select: false`.) It was the
   * one read path on this controller that the findOne() scoping fix missed.
   *
   * Scoped the same way as findOne(): own tenant plus platform system roles.
   */
  async getUsersCount(
    id: string,
    caller?: User,
  ): Promise<{ count: number; users: User[] }> {
    const role = await this.roleRepository
      .createQueryBuilder('role')
      .leftJoinAndSelect('role.users', 'users')
      .where('role.id = :id', { id })
      .getOne();

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    this.assertCallerMaySee(role, caller);

    return {
      count: role.users?.length || 0,
      users: role.users || [],
    };
  }
}