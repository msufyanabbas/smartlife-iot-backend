import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, Like, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { User } from './entities/user.entity';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  UserRole,
  UserStatus,
} from '@common/enums/index.enum';
import {
  CreateUserDto,
  UpdateUserDto,
  UserChangePasswordDto,
  UserResetPasswordDto,
  UserForgotPasswordDto,
  UpdatePreferencesDto,
  BulkUpdateStatusDto,
  InviteUserDto,
  BulkDeleteUsersDto,
  BulkAssignRoleDto,
  BulkRemoveRoleDto,
  BulkUpdatePermissionsDto,
  BulkSendEmailDto,
  BulkSendNotificationDto,
} from './dto/users.dto';
import { MailService } from '../../modules/mail/mail.service';
import { Permission } from '../permissions/entities/permissions.entity';
import { Role } from '../roles/entities/roles.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import {
  BulkOutcome,
  BulkResultBuilder,
  BulkResultDto,
} from '@common/dto/bulk-operation.dto';
import {
  BulkDeleteUsersByIdDto,
  BulkUpdateUsersDto,
} from './dto/bulk-user.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PermissionCacheService } from '@lib/redis/permission-cache.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private eventEmitter: EventEmitter2,
    private mailService: MailService,
    @InjectRepository(Role)
    private roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private permissionRepository: Repository<Permission>,
    private notificationsService: NotificationsService,
    // forwardRef, not a plain inject: SubscriptionsModule already imports
    // UsersModule (also via forwardRef), so resolving this eagerly would close
    // the loop at bootstrap.
    @Inject(forwardRef(() => SubscriptionsService))
    private subscriptionsService: SubscriptionsService,
    private configService: ConfigService,
    // Bulk operations commit one transaction per item — see bulkDelete.
    private readonly dataSource: DataSource,
    // From the @Global RedisModule. PermissionGuard caches each user's
    // resolved permission set; anything here that changes a role assignment,
    // a direct grant or `enforcePermissions` has to invalidate it, or the old
    // set keeps being honoured for up to PERMISSION_CACHE_TTL_SECONDS.
    private readonly permissionCache: PermissionCacheService,
  ) {}

  /**
   * Drop cached permission sets for every tenant represented in `users`.
   *
   * Bulk routes take arbitrary user ids, which can span tenants, so a single
   * bump is not enough. Deduplicated because the epoch is per tenant and
   * bumping it twice for the same tenant achieves nothing but a round trip.
   */
  private async invalidatePermissionCache(
    users: Array<{ tenantId?: string | null }>,
  ): Promise<void> {
    const tenantIds = new Set(
      users.map((u) => u.tenantId).filter((t): t is string => !!t),
    );
    for (const tenantId of tenantIds) {
      await this.permissionCache.bumpTenant(tenantId);
    }
  }

  // ── Actor scoping: who may create or re-privilege whom ────────────────────
  //
  // Everything in this block exists because three WRITE routes in this module
  // took their target and their privilege level straight from the request body
  // with no actor at all. It is the §4g shape one level up: not "whose row is
  // this" but "whose authority is this".

  /**
   * Rank ladder for "may this actor hand out this role".
   *
   * USER and CUSTOMER_USER share a rank: neither administers anyone, they
   * differ only in which scope they read. A role missing from this map ranks
   * as unreachable (see `assertRoleCreatable`), so adding a new UserRole
   * member fails closed rather than silently becoming grantable by everyone.
   */
  private static readonly ROLE_RANK: Readonly<Record<UserRole, number>> = {
    [UserRole.SUPER_ADMIN]: 100,
    [UserRole.TENANT_ADMIN]: 50,
    [UserRole.CUSTOMER]: 20,
    [UserRole.CUSTOMER_USER]: 10,
    [UserRole.USER]: 10,
  };

  /**
   * Resources no tenant administers — the platform does.
   *
   * This is not a guess: the role seeder's own "Tenant Administrator" role is
   * built as `allPermissions.filter(p => !['tenants','billing'].includes(p.resource))`,
   * so these two are already the documented ceiling of tenant authority. A
   * tenant admin who could *assign* a role carrying `tenants:delete` would
   * hold it transitively — grant it to a throwaway USER account, log in as
   * that account, delete every organisation on the platform. The seeded
   * system roles "Super Administrator" and "Platform Administrator" both
   * carry exactly that, and both are `tenantId IS NULL`, which is why a plain
   * "system roles are shared" predicate is not sufficient on its own.
   */
  private static readonly PLATFORM_ONLY_RESOURCES: readonly string[] = [
    'tenants',
    'billing',
  ];

  /** Postgres raises `invalid input syntax for type uuid` on a malformed id
   * inside `In(...)`, which turns a bad request body into a 500. Ids are
   * screened here so a malformed one is reported as out of scope instead. */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * The tenant a newly created user actually lands in.
   *
   * SUPER_ADMIN is the only role legitimately tenant-less and the only one
   * that may name a tenant; for everyone else the actor's own tenant is
   * forced over whatever the body said.
   */
  private resolveTenantForCreate(
    createUserDto: CreateUserDto,
    actor: User,
  ): string | undefined {
    if (actor.role === UserRole.SUPER_ADMIN) {
      return createUserDto.tenantId;
    }

    if (!actor.tenantId) {
      // §4g: a falsy tenantId on a non-super-admin denies. Falling through
      // here would create the user with `tenantId: undefined` — a row outside
      // every tenant's scope, which no tenant-scoped read can ever see or
      // clean up.
      this.logger.warn(
        `User create from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      throw new ForbiddenException(
        'Your account is not attached to a tenant and cannot create users',
      );
    }

    if (createUserDto.tenantId && createUserDto.tenantId !== actor.tenantId) {
      // Forced, not rejected: the caller gets the user they asked for, in the
      // only tenant they are entitled to. Logged because a body naming
      // another tenant is an attempted cross-tenant write, not a typo.
      this.logger.warn(
        `User create from ${actor.id} named tenant ${createUserDto.tenantId}; ` +
          `forced to the actor's own tenant ${actor.tenantId}`,
      );
    }

    return actor.tenantId;
  }

  /**
   * The role a newly created user may actually be given.
   *
   * `undefined` is returned unchanged so the column default
   * (`CUSTOMER_USER`) still applies — the weakest role there is, so there is
   * nothing to check.
   *
   * STRICTLY above the actor is refused. EQUAL is allowed, which means a
   * TENANT_ADMIN may create another TENANT_ADMIN **inside its own tenant**,
   * and that is deliberate: this module already refuses to delete or
   * deactivate a tenant's last remaining admin precisely because a tenant
   * with no administrator is unrecoverable through the API. A tenant that
   * cannot appoint a second admin has a bus factor of one and has to open a
   * support ticket to fix it. The dangerous direction — a tenant admin
   * minting a SUPER_ADMIN, which is tenant-less and therefore outside its own
   * tenant — is strictly above and refused.
   */
  private assertRoleCreatable(
    requested: UserRole | undefined,
    actor: User,
  ): UserRole | undefined {
    if (requested === undefined) return undefined;
    if (actor.role === UserRole.SUPER_ADMIN) return requested;

    // Unknown role on either side ranks as unreachable / powerless.
    const requestedRank = UsersService.ROLE_RANK[requested] ?? Number.MAX_SAFE_INTEGER;
    const actorRank = UsersService.ROLE_RANK[actor.role] ?? -1;

    if (requestedRank > actorRank) {
      throw new ForbiddenException(
        `You cannot create a user with the role "${requested}" — it is at or ` +
          `above your own authority (${actor.role}).`,
      );
    }

    return requested;
  }

  /**
   * Resolve the role named by an assign/remove request inside the actor's
   * authority.
   *
   * `bulkAssignRole` used to be `roleRepository.findOne({ where: { id } })`
   * with no tenant predicate, so a tenant admin of A could attach tenant B's
   * custom role — or the platform's "Super Administrator" — to any user whose
   * uuid they knew.
   *
   * `intent` matters: 'assign' widens what a user can do and is held to the
   * platform-resource ceiling, 'remove' only narrows. A de-escalation must
   * never be refusable, or an admin who made a mistake (or inherited a bad
   * grant from before this fix) has no way to undo it.
   */
  private async resolveRoleForActor(
    roleId: string,
    actor: User,
    intent: 'assign' | 'remove',
  ): Promise<Role> {
    const notFound = () => new NotFoundException(`Role ${roleId} not found`);

    if (!UsersService.UUID_RE.test(roleId)) throw notFound();

    const role = await this.roleRepository.findOne({
      where: { id: roleId },
      relations: ['permissions'],
    });

    if (!role) throw notFound();
    if (actor.role === UserRole.SUPER_ADMIN) return role;

    if (!actor.tenantId) {
      this.logger.warn(
        `Role ${intent} from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      throw notFound();
    }

    // A role with no tenantId is a system role: the shared platform
    // vocabulary every tenant draws on (RolesService reads it the same way).
    // A role WITH a tenantId belongs to exactly that tenant.
    //
    // 404, not 403: a 403 would confirm that the uuid names a real role in
    // someone else's tenant.
    if (role.tenantId && role.tenantId !== actor.tenantId) throw notFound();

    if (intent === 'assign') {
      const reserved = (role.permissions ?? [])
        .filter((p) =>
          UsersService.PLATFORM_ONLY_RESOURCES.includes(p.resource),
        )
        .map((p) => `${p.resource}:${p.action}`);

      if (reserved.length > 0) {
        // Forbidden rather than not-found here, and that is safe: a system
        // role is already readable by every tenant through GET /roles, so
        // naming it leaks nothing the caller could not already list. An
        // opaque 404 would instead look like a bug in the picker.
        throw new ForbiddenException(
          `"${role.name}" grants platform-level permissions ` +
            `(${[...new Set(reserved)].sort().join(', ')}) and can only be ` +
            'assigned by a platform administrator.',
        );
      }
    }

    return role;
  }

  /**
   * Resolve the direct permissions named by a grant inside the actor's
   * authority. Same reasoning as `resolveRoleForActor`, applied to the
   * permission rows `bulkUpdatePermissions` attaches.
   */
  private async resolvePermissionsForActor(
    permissionIds: string[],
    actor: User,
    intent: 'grant' | 'revoke',
  ): Promise<Permission[]> {
    const unique = [...new Set(permissionIds)];
    if (unique.length === 0) return [];

    const wellFormed = unique.filter((id) => UsersService.UUID_RE.test(id));

    const rows = await this.permissionRepository.find({
      where: { id: In(wellFormed) },
    });

    const isSuperAdmin = actor.role === UserRole.SUPER_ADMIN;

    if (!isSuperAdmin && !actor.tenantId) {
      this.logger.warn(
        `Permission ${intent} from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      throw new BadRequestException(
        'Your account is not attached to a tenant and cannot change permissions',
      );
    }

    // A revoke only narrows: the ids are used as a filter over what the user
    // ALREADY holds, so they cannot grant anything and must stay usable even
    // for a row that predates this scoping (otherwise a bad legacy grant is
    // permanent). Existence is still required so a typo is not reported as a
    // successful revocation.
    const inScope = isSuperAdmin || intent === 'revoke'
      ? rows
      : rows.filter((p) => !p.tenantId || p.tenantId === actor.tenantId);

    const found = new Set(inScope.map((p) => p.id));
    const rejected = unique.filter((id) => !found.has(id));

    if (rejected.length > 0) {
      // One message for "does not exist" and "not yours" together: splitting
      // them would turn this route into a probe for another tenant's custom
      // permission ids.
      throw new BadRequestException({
        message: `${rejected.length} of ${unique.length} permission IDs are unknown or not available to your tenant`,
        errors: rejected,
      });
    }

    if (intent === 'grant' && !isSuperAdmin) {
      const reserved = inScope
        .filter((p) =>
          UsersService.PLATFORM_ONLY_RESOURCES.includes(p.resource),
        )
        .map((p) => `${p.resource}:${p.action}`);

      if (reserved.length > 0) {
        throw new ForbiddenException(
          `Platform-level permissions (${[...new Set(reserved)].sort().join(', ')}) ` +
            'can only be granted by a platform administrator.',
        );
      }
    }

    return inScope;
  }

  /**
   * Re-resolve every user id a privilege write names, inside the actor's
   * tenant, and REFUSE the request if any id falls outside.
   *
   * The bulk role/permission routes used to run `find({ where: { id: In(ids) } })`
   * with no tenant predicate at all, so a tenant admin of A could re-role any
   * account on the platform by uuid.
   *
   * Refusing beats skipping: `bulkAssignRole` returned `{ updated: n }`, so a
   * silently dropped id showed the administrator a success for a change that
   * never happened — and a role assignment that is believed to have been made
   * and was not is exactly as dangerous as one made by mistake.
   */
  private async resolveUsersForPrivilegeWrite(
    userIds: string[],
    actor: User,
    relations: string[],
  ): Promise<User[]> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return [];

    if (actor.role !== UserRole.SUPER_ADMIN && !actor.tenantId) {
      this.logger.warn(
        `Privilege write from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      throw new NotFoundException(
        `0 of ${unique.length} users are in your scope`,
      );
    }

    const wellFormed = unique.filter((id) => UsersService.UUID_RE.test(id));

    const where =
      actor.role === UserRole.SUPER_ADMIN
        ? { id: In(wellFormed) }
        : { id: In(wellFormed), tenantId: actor.tenantId };

    const rows = wellFormed.length
      ? await this.userRepository.find({ where, relations })
      : [];

    const found = new Set(rows.map((u) => u.id));
    const outside = unique.filter((id) => !found.has(id));

    if (outside.length > 0) {
      // 404 and no distinction between "no such user" and "another tenant's
      // user" — §4g: a 403 here would confirm the uuid exists elsewhere. The
      // ids echoed back are the caller's own input, so nothing is disclosed.
      throw new NotFoundException({
        message: `${outside.length} of ${unique.length} users are not in your scope`,
        errors: outside,
      });
    }

    return rows;
  }

  /**
   * Create a new user.
   *
   * `actor` is REQUIRED, not optional. `POST /users` used to take no
   * `@CurrentUser()` at all and this method trusted `role` and `tenantId`
   * straight out of the body, so anyone holding `users:create` could mint a
   * `super_admin` or plant an account inside another tenant by putting it in
   * the JSON. An optional actor would be the same hole with a default
   * argument in front of it — §4g's "a falsy tenantId must deny, not skip".
   */
  async create(createUserDto: CreateUserDto, actor: User): Promise<User> {
    // Resolved BEFORE the uniqueness probe so a cross-tenant or escalating
    // body is refused without also telling the caller whether the email is
    // already taken somewhere on the platform.
    const tenantId = this.resolveTenantForCreate(createUserDto, actor);
    const role = this.assertRoleCreatable(createUserDto.role, actor);

    // A customer belongs to exactly one tenant, so an id from another tenant
    // would attach the new login to a foreign organisation.
    if (createUserDto.customerId) {
      await this.assertCustomerInTenantId(createUserDto.customerId, tenantId);
    }

    // Check if user already exists.
    // Deliberately NOT tenant-scoped: `users.email` is the platform-wide
    // unique login identifier and the password-reset destination.
    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    const user = this.userRepository.create({
      ...createUserDto,
      // After the spread, never before: these two are the security boundary
      // and the body must not be able to win.
      tenantId,
      ...(role !== undefined ? { role } : {}),
      emailVerificationToken,
      emailVerified: false,
    });

    const savedUser = await this.userRepository.save(user);

    // Keep subscription.usage.users honest — POST /users is guarded by
    // @RequireSubscriptionLimit({ resource: 'users' }), which reads this counter.
    //
    // Guarded on tenantId: a SUPER_ADMIN has no tenant and no subscription.
    // No double-count risk with CustomerListener's 'users' increment —
    // CustomersService and AuthService.register() both write the user row
    // through their own repository rather than through this method.
    if (savedUser.tenantId) {
      try {
        await this.subscriptionsService.incrementTenantUsage(
          savedUser.tenantId,
          'users',
          1,
        );
      } catch (err) {
        this.logger.error(
          `Failed to increment users usage for tenant ${savedUser.tenantId}`,
          err,
        );
      }
    }

    // Send verification email
    await this.sendVerificationEmail(savedUser);

    // Emit event. The flat tenantId/customerId are what the audit handler
    // scopes its row by; `{ user }` alone left it undefined and the NOT NULL
    // insert threw inside the listener.
    this.eventEmitter.emit('user.created', {
      user: savedUser,
      tenantId: savedUser.tenantId,
      customerId: savedUser.customerId,
    });

    return savedUser;
  }

  /**
   * Find all users with pagination and filters
   */
  async findAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    role?: UserRole;
    status?: UserStatus;
    tenantId?: string;
  }): Promise<PaginatedResponseDto<User>> {
    const page = options.page || 1;
    const limit = options.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.userRepository.createQueryBuilder('user');

    // Apply filters
    if (options.search) {
      queryBuilder.andWhere(
        '(user.name ILIKE :search OR user.email ILIKE :search)',
        { search: `%${options.search}%` },
      );
    }

    if (options.role) {
      queryBuilder.andWhere('user.role = :role', { role: options.role });
    }

    if (options.status) {
      queryBuilder.andWhere('user.status = :status', {
        status: options.status,
      });
    }

    if (options.tenantId) {
      queryBuilder.andWhere('user.tenantId = :tenantId', {
        tenantId: options.tenantId,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const users = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('user.createdAt', 'DESC')
      .getMany();

    return PaginatedResponseDto.create(users, page, limit, total);
  }

  /**
   * Find one user by ID
   */
  /**
   * Load a user by id.
   *
   * **Unscoped on purpose, and only safe for internal callers** that have
   * already established who may see the row — `JwtStrategy` resolving the
   * caller themselves, `CustomerUsersService` acting within a customer it has
   * already checked. Anything reachable from a controller must use
   * `findOneScoped()` instead.
   */
  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  /**
   * Load a user by id, visible only to a caller entitled to see them.
   *
   * `GET /users/:id` used to call the unscoped `findOne` above with no
   * `@Roles` on the handler, so **any authenticated user could read any user
   * row in the platform by id** — email, status, role, tenant, the lot — just
   * by guessing or harvesting a uuid. A uuid is not an access control.
   *
   * The rule mirrors the device filter: SUPER_ADMIN sees everyone; everyone
   * else is confined to their own tenant, and a customer-scoped caller to
   * their own customer. A caller may always read themselves.
   */
  async findOneScoped(id: string, caller: User): Promise<User> {
    const user = await this.findOne(id);

    if (caller.role === UserRole.SUPER_ADMIN) return user;
    if (caller.id === id) return user;

    // Only SUPER_ADMIN is legitimately tenant-less; a falsy tenantId here must
    // deny rather than match everything.
    if (!caller.tenantId || user.tenantId !== caller.tenantId) {
      // 404, not 403: a caller must not be able to confirm that a user id
      // exists in another tenant.
      throw new NotFoundException('User not found');
    }

    if (
      caller.role === UserRole.CUSTOMER ||
      caller.role === UserRole.CUSTOMER_USER
    ) {
      if (!caller.customerId || user.customerId !== caller.customerId) {
        throw new NotFoundException('User not found');
      }
    }

    return user;
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    return await this.userRepository.findOne({ where: { email } });
  }

  /**
   * Update user
   */
  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    actor: User,
  ): Promise<User> {
    // ── Why this takes an actor ──────────────────────────────────────────
    //
    // `create()` forces the tenant and refuses a role above the caller's own,
    // but that was only as strong as the next route along. This one resolved
    // through `findOne()` — whose own docblock says it is "unscoped on
    // purpose, and only safe for internal callers" — and `UpdateUserDto`
    // carries BOTH `role` and `tenantId`.
    //
    // So the create fix was bypassable in two moves: create a user (correctly
    // placed in your own tenant), then PATCH them to `super_admin`. Or skip
    // that and PATCH any user in any tenant by uuid.
    //
    // Same resolver as the bulk privilege writes, so the scoping cannot drift
    // between them.
    const [user] = await this.resolveUsersForPrivilegeWrite([id], actor, [
      'roles',
    ]);

    // Check if email is being changed and if it's already taken
    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingUser = await this.findByEmail(updateUserDto.email);
      if (existingUser) {
        throw new ConflictException('Email already in use');
      }
      // If email changed, mark as unverified
      user.emailVerified = false;
      user.emailVerificationToken = crypto.randomBytes(32).toString('hex');
    }

    // A role change is an escalation check, not a field assignment: without
    // this, `{ role: 'super_admin' }` in the body is a free promotion.
    if (updateUserDto.role && updateUserDto.role !== user.role) {
      this.assertRoleCreatable(updateUserDto.role, actor);
    }

    // Moving a user between tenants is not an edit — it would detach them from
    // their customer, their roles and their assignments in one PATCH. Only a
    // super admin may do it; for anyone else the field is ignored rather than
    // honoured, and the attempt is logged because it is a cross-tenant write.
    if (
      updateUserDto.tenantId &&
      updateUserDto.tenantId !== user.tenantId &&
      actor.role !== UserRole.SUPER_ADMIN
    ) {
      this.logger.warn(
        `User ${actor.id} attempted to move user ${id} from tenant ` +
          `${user.tenantId} to ${updateUserDto.tenantId} — ignored`,
      );
      delete (updateUserDto as Partial<UpdateUserDto>).tenantId;
    }

    const previousRole = user.role;

    // Only the keys the DTO carries, captured before the assign — a whole-row
    // diff would put `preferences` and the password hash column into the audit
    // row's `changes` jsonb.
    const before: Record<string, any> = {};
    for (const key of Object.keys(updateUserDto)) {
      before[key] = (user as any)[key];
    }

    Object.assign(user, updateUserDto);

    const updatedUser = await this.userRepository.save(user);

    // `update()` can change three things the permission resolution depends on:
    // `role` (SUPER_ADMIN and TENANT_ADMIN short-circuit the guard entirely),
    // `enforcePermissions` (the opt-in that makes a tenant admin's grants real
    // — see §4k) and `customerId` (which decides whether the set is
    // intersected with the customer's ceiling). Bumping unconditionally rather
    // than inspecting the DTO: the cost is one rebuilt query, and the cost of
    // getting the condition subtly wrong is a stale privilege.
    await this.permissionCache.bumpTenant(updatedUser.tenantId);

    // Emit event. `tenantId`/`customerId` are passed explicitly: the audit
    // handler needs a tenant (audit_logs.tenantId is NOT NULL) and `{ user }`
    // alone left it undefined, so the INSERT threw inside a listener nobody
    // awaits — the row was silently never written.
    this.eventEmitter.emit('user.updated', {
      user: updatedUser,
      tenantId: updatedUser.tenantId,
      customerId: updatedUser.customerId,
      changes: { before, after: { ...updateUserDto } },
    });

    // A role change is a privilege change and deserves its own entry rather
    // than being buried in a field diff. `user.role.changed` had a handler and
    // no emitter.
    if (updateUserDto.role && updateUserDto.role !== previousRole) {
      this.eventEmitter.emit('user.role.changed', {
        userId: updatedUser.id,
        userName: updatedUser.name,
        email: updatedUser.email,
        tenantId: updatedUser.tenantId,
        customerId: updatedUser.customerId,
        oldRole: previousRole,
        newRole: updatedUser.role,
      });
    }

    return updatedUser;
  }

  /**
   * Delete user (soft delete)
   */
  async remove(id: string, actor: User): Promise<void> {
    // Scoped for the same reason as update(): this resolved through the
    // deliberately-unscoped findOne(), so any user in any tenant could be
    // soft-deleted by uuid.
    const [user] = await this.resolveUsersForPrivilegeWrite([id], actor, []);

    await this.userRepository.softRemove(user);

    if (user.tenantId) {
      try {
        await this.subscriptionsService.decrementTenantUsage(
          user.tenantId,
          'users',
          1,
        );
      } catch (err) {
        this.logger.error(
          `Failed to decrement users usage for tenant ${user.tenantId}`,
          err,
        );
      }
    }

    // Emit event
    this.eventEmitter.emit('user.deleted', {
      userId: id,
      userEmail: user.email,
      role: user.role,
      customerId: user.customerId,
      tenantId: user.tenantId,
    });
  }

  /**
   * Change password
   */
  async changePassword(
    userId: string,
    changePasswordDto: UserChangePasswordDto,
  ): Promise<void> {
    const user = await this.findOne(userId);

    // Verify current password
    const isPasswordValid = await user.comparePassword(
      changePasswordDto.currentPassword,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Update password
    user.password = changePasswordDto.newPassword;
    await this.userRepository.save(user);

    // Emit event — tenantId is required by the audit handler.
    this.eventEmitter.emit('user.password.changed', {
      userId,
      userName: user.name,
      email: user.email,
      tenantId: user.tenantId,
      customerId: user.customerId,
    });

    // Send email notification
    await this.mailService.sendEmail({
      to: user.email,
      subject: 'Password Changed',
      text: 'Your password has been successfully changed.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Password Changed</h2>
          <p>Your password has been successfully changed.</p>
          <p>If you didn't make this change, please contact support immediately.</p>
        </div>
      `,
    });
  }

  /**
   * Forgot password - send reset token
   */
  async forgotPassword(
    forgotPasswordDto: UserForgotPasswordDto,
  ): Promise<void> {
    const user = await this.findByEmail(forgotPasswordDto.email);

    if (!user) {
      // Don't reveal if user exists
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 3600000); // 1 hour

    await this.userRepository.save(user);

    // Send reset email
    await this.mailService.sendEmail({
      to: user.email,
      subject: 'Password Reset Request',
      text: `Reset your password using this token: ${resetToken}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Password Reset Request</h2>
          <p>You requested to reset your password.</p>
          <p>Your reset token: <strong>${resetToken}</strong></p>
          <p>This token will expire in 1 hour.</p>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      `,
    });

    // Emit event
    this.eventEmitter.emit('user.password.reset.requested', {
      userId: user.id,
    });
  }

  /**
   * Reset password with token
   */
  async resetPassword(resetPasswordDto: UserResetPasswordDto): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { passwordResetToken: resetPasswordDto.token },
    });

    if (!user || !user.passwordResetExpires) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (new Date() > user.passwordResetExpires) {
      throw new BadRequestException('Reset token has expired');
    }

    // Update password and clear reset token
    user.password = resetPasswordDto.newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('user.password.reset.completed', {
      userId: user.id,
    });

    // Send confirmation email
    await this.mailService.sendEmail({
      to: user.email,
      subject: 'Password Reset Successful',
      text: 'Your password has been successfully reset.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Password Reset Successful</h2>
          <p>Your password has been successfully reset.</p>
          <p>You can now login with your new password.</p>
          <p>If you didn't make this change, please contact support immediately.</p>
        </div>
      `,
    });
  }

  /**
   * Verify email
   */
  async verifyEmail(token: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid verification token');
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;

    await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('user.email.verified', { userId: user.id });
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(userId: string): Promise<void> {
    const user = await this.findOne(userId);

    if (user.emailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    // Generate new token
    user.emailVerificationToken = crypto.randomBytes(32).toString('hex');
    await this.userRepository.save(user);

    await this.sendVerificationEmail(user);
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    userId: string,
    updatePreferencesDto: UpdatePreferencesDto,
  ): Promise<User> {
    const user = await this.findOne(userId);

    user.preferences = {
      ...user.preferences,
      ...updatePreferencesDto.preferences,
    };

    return await this.userRepository.save(user);
  }

  /**
   * Update user status
   */
  async updateStatus(
    userId: string,
    status: UserStatus,
    actor: User,
  ): Promise<User> {
    // Scoped like update() and remove(): deactivating a user is a privilege
    // write, and this resolved through the unscoped findOne().
    const [user] = await this.resolveUsersForPrivilegeWrite([userId], actor, []);
    user.status = status;

    const updatedUser = await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('user.status.changed', {
      userId,
      role: user.role,
      customerId: user.customerId,
      tenantId: user.tenantId,
      status,
      previousStatus: user.status,
    });
    return updatedUser;
  }

  // ── Bulk delete / bulk update (per-id outcomes) ────────────────────────────
  //
  // TRANSACTION GRANULARITY: ONE TRANSACTION PER ITEM, deliberately. A
  // per-batch transaction would roll back 49 good deletes because the 50th id
  // belonged to another tenant, which is the opposite of what these routes
  // are for.
  //
  // TENANT SCOPING: every id is re-resolved against the caller's tenant in
  // resolveForBulk() before anything is written. The previous untenanted
  // bulk helpers below now route through it — they selected by
  // `id IN (...)` with no tenant predicate at all, so a TENANT_ADMIN who knew
  // a uuid could soft-delete another tenant's users and flip their statuses.
  //
  // COUNTERS: `subscriptions.usage.users` is decremented once per tenant for
  // the number actually deleted. `POST /users` is gated by
  // @RequireSubscriptionLimit({resource:'users'}) reading that counter, so a
  // bulk delete that skipped it would leave the tenant unable to create users
  // it has quota for. CustomerListener's own 'users' decrement fires on
  // `customer.deleted`, which this path does not emit, so there is no
  // double-count.
  //
  // CASCADES: `user.deleted` is emitted per deleted user so CustomerListener
  // removes the paired Customer row for CUSTOMER-role users — the same
  // cascade the single-user remove() triggers. Notifications addressed to the
  // user are kept (their FK CASCADE does not fire on a soft delete, and a
  // notification history is not the user's account).
  //
  // BLOCKS: the caller's own row, any SUPER_ADMIN row, and the tenant's last
  // remaining TENANT_ADMIN. Deleting the last admin leaves a tenant with
  // paying data and nobody able to administer it, and it cannot be undone
  // through the API.

  async bulkDelete(
    dto: BulkDeleteUsersByIdDto,
    actor: User,
  ): Promise<BulkResultDto> {
    const result = new BulkResultBuilder(dto.ids);
    const users = await this.resolveForBulk(result.ids, actor);

    // Remaining-admin budget per tenant, so deleting four of five admins
    // succeeds and deleting all five blocks on the last one.
    const adminsLeft = await this.countTenantAdmins(
      [...new Set([...users.values()].map((u) => u.tenantId).filter((t): t is string => !!t))],
      false,
    );

    const deleted: User[] = [];

    for (const id of result.ids) {
      const user = users.get(id);

      if (!user) {
        result.notFound(id, 'User not found in your scope');
        continue;
      }

      if (user.id === actor.id) {
        result.blocked(id, 'You cannot delete your own account');
        continue;
      }

      if (user.role === UserRole.SUPER_ADMIN) {
        result.blocked(id, 'Platform super admins cannot be deleted in bulk');
        continue;
      }

      if (user.role === UserRole.TENANT_ADMIN && user.tenantId) {
        const left = adminsLeft.get(user.tenantId) ?? 0;
        if (left <= 1) {
          result.blocked(
            id,
            'This is the last tenant admin — the tenant would be left with no administrator',
          );
          continue;
        }
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.softRemove(user);
        });
        if (user.role === UserRole.TENANT_ADMIN && user.tenantId) {
          adminsLeft.set(user.tenantId, (adminsLeft.get(user.tenantId) ?? 1) - 1);
        }
        deleted.push(user);
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk delete failed for user ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    await this.releaseUserQuota(deleted);

    // Per user, not per batch: CustomerListener cascades one Customer row per
    // CUSTOMER-role user.
    for (const user of deleted) {
      this.eventEmitter.emit('user.deleted', {
        userId: user.id,
        userEmail: user.email,
        role: user.role,
        customerId: user.customerId,
        tenantId: user.tenantId,
      });
    }

    return result.build();
  }

  async bulkUpdate(
    dto: BulkUpdateUsersDto,
    actor: User,
  ): Promise<BulkResultDto> {
    // See BulkUpdateUsersDto for the field set and why role / password /
    // tenantId / email are not in it. `undefined` leaves a field alone;
    // `null` clears customerId. The patch is applied with update(), not
    // save(), because save() treats a property set to undefined as unchanged
    // and would silently fail to clear a column.
    const patch: Record<string, unknown> = {};
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.customerId !== undefined) patch.customerId = dto.customerId;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        message: 'No updatable field supplied',
        errors: [
          'Supply at least one of: status, customerId',
          'role, password, tenantId and email are deliberately not bulk-updatable',
        ],
      });
    }

    if (dto.customerId) {
      await this.assertCustomerInTenant(dto.customerId, actor);
    }

    const result = new BulkResultBuilder(dto.ids);
    const users = await this.resolveForBulk(result.ids, actor);

    const deactivating =
      dto.status !== undefined && dto.status !== UserStatus.ACTIVE;

    const activeAdminsLeft = deactivating
      ? await this.countTenantAdmins(
          [...new Set([...users.values()].map((u) => u.tenantId).filter((t): t is string => !!t))],
          true,
        )
      : new Map<string, number>();

    const updated: User[] = [];

    for (const id of result.ids) {
      const user = users.get(id);

      if (!user) {
        result.notFound(id, 'User not found in your scope');
        continue;
      }

      if (deactivating && user.id === actor.id) {
        result.blocked(id, 'You cannot deactivate your own account');
        continue;
      }

      if (
        deactivating &&
        user.role === UserRole.TENANT_ADMIN &&
        user.status === UserStatus.ACTIVE &&
        user.tenantId
      ) {
        const left = activeAdminsLeft.get(user.tenantId) ?? 0;
        if (left <= 1) {
          result.blocked(
            id,
            'This is the last active tenant admin — the tenant would be locked out',
          );
          continue;
        }
      }

      const changes = Object.entries(patch).filter(
        ([key, value]) => (user[key as keyof User] ?? null) !== (value ?? null),
      );

      if (changes.length === 0) {
        result.skipped(id, 'Already in the requested state');
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.update(User, { id: user.id }, patch);
        });
        if (
          deactivating &&
          user.role === UserRole.TENANT_ADMIN &&
          user.status === UserStatus.ACTIVE &&
          user.tenantId
        ) {
          activeAdminsLeft.set(
            user.tenantId,
            (activeAdminsLeft.get(user.tenantId) ?? 1) - 1,
          );
        }
        updated.push(user);
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk update failed for user ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    // CustomerListener syncs a CUSTOMER-role user's paired Customer row off
    // this event, so a bulk status change has to emit it or the customer row
    // drifts out of step with its login account.
    if (dto.status !== undefined && updated.length > 0) {
      this.eventEmitter.emit('users.status.bulk.updated', {
        status: dto.status,
        affectedUsers: updated.map((u) => ({
          userId: u.id,
          role: u.role,
          customerId: u.customerId,
          tenantId: u.tenantId,
        })),
      });
    }

    return result.build();
  }

  // ── Bulk helpers ───────────────────────────────────────────────────────────

  /**
   * Re-resolves every requested id inside the caller's tenant. This is the
   * security boundary of the bulk routes: the body is a bare uuid array, so
   * nothing else stops a caller submitting another tenant's user ids.
   *
   * A SUPER_ADMIN is unscoped (they have no tenantId by design). Anyone else
   * without a tenantId is denied outright rather than falling through to an
   * unscoped query.
   */
  private async resolveForBulk(
    ids: string[],
    actor: User,
  ): Promise<Map<string, User>> {
    if (ids.length === 0) return new Map();

    if (actor.role !== UserRole.SUPER_ADMIN && !actor.tenantId) {
      this.logger.warn(
        `Bulk user request from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      return new Map();
    }

    const where =
      actor.role === UserRole.SUPER_ADMIN
        ? { id: In(ids) }
        : { id: In(ids), tenantId: actor.tenantId };

    const rows = await this.userRepository.find({ where });
    return new Map(rows.map((user) => [user.id, user]));
  }

  /** tenantId → number of TENANT_ADMIN rows left (optionally only ACTIVE ones). */
  private async countTenantAdmins(
    tenantIds: string[],
    activeOnly: boolean,
  ): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();

    const rows: Array<{ tenantId: string; count: string }> =
      await this.dataSource.query(
        `SELECT "tenantId", COUNT(*) AS count
           FROM users
          WHERE "tenantId" = ANY($1)
            AND role::text = $2
            AND deleted_at IS NULL
            ${activeOnly ? 'AND status::text = $3' : ''}
          GROUP BY "tenantId"`,
        activeOnly
          ? [tenantIds, UserRole.TENANT_ADMIN, UserStatus.ACTIVE]
          : [tenantIds, UserRole.TENANT_ADMIN],
      );

    return new Map(rows.map((row) => [row.tenantId, Number(row.count)]));
  }

  private async assertCustomerInTenant(
    customerId: string,
    actor: User,
  ): Promise<void> {
    await this.assertCustomerInTenantId(customerId, actor.tenantId);
  }

  /**
   * Same check against an explicit tenant rather than the actor's own.
   *
   * `create()` needs this because a SUPER_ADMIN may place the new user in any
   * tenant, and the customer then has to belong to THAT tenant — not to the
   * (absent) tenant of the super admin.
   */
  private async assertCustomerInTenantId(
    customerId: string,
    tenantId: string | undefined | null,
  ): Promise<void> {
    if (!UsersService.UUID_RE.test(customerId)) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const rows: Array<{ id: string }> = await this.dataSource.query(
      tenantId
        ? `SELECT id FROM customers WHERE id = $1 AND "tenantId" = $2 AND deleted_at IS NULL`
        : `SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL`,
      tenantId ? [customerId, tenantId] : [customerId],
    );

    if (rows.length === 0) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }
  }

  /**
   * One UPDATE per distinct tenant rather than one per user — a bulk delete
   * can span tenants for a SUPER_ADMIN, and N single-step updates on the same
   * subscription row would be N write conflicts. Non-fatal: the users ARE
   * deleted, so a failed counter write must not be reported as a failed
   * delete.
   */
  private async releaseUserQuota(users: User[]): Promise<void> {
    const perTenant = new Map<string, number>();
    for (const user of users) {
      if (!user.tenantId) continue;
      perTenant.set(user.tenantId, (perTenant.get(user.tenantId) ?? 0) + 1);
    }

    for (const [tenantId, count] of perTenant) {
      try {
        await this.subscriptionsService.decrementTenantUsage(
          tenantId,
          'users',
          count,
        );
      } catch (err) {
        this.logger.error(
          `Failed to decrement users usage for tenant ${tenantId} by ${count}`,
          err,
        );
      }
    }
  }

  // ── Legacy bulk shims ──────────────────────────────────────────────────────
  //
  // Both of these were tenant-unscoped: they matched `id IN (:...ids)` with no
  // tenant predicate, so any admin who knew a uuid could delete or re-status
  // another tenant's users. They now delegate to the scoped implementations
  // above and keep their original response shapes so the existing routes do
  // not change contract.

  /** @deprecated Use POST /users/bulk/delete, which returns per-id outcomes. */
  async bulkDeleteLegacy(
    dto: BulkDeleteUsersDto,
    actor: User,
  ): Promise<{ deleted: number }> {
    const result = await this.bulkDelete({ ids: dto.userIds }, actor);
    return {
      deleted: result.outcomes.filter(
        (o) => o.outcome === BulkOutcome.SUCCESS,
      ).length,
    };
  }

  // ── Role assignment: single and bulk ──────────────────────────────────────
  //
  // All four entry points below resolve the ROLE and the USERS through
  // `resolveRoleForActor` / `resolveUsersForPrivilegeWrite` and then share one
  // writer, so the scoping cannot drift between the single and the bulk path —
  // which is exactly how the single path would otherwise end up being the next
  // hole.

  /**
   * `POST /users/:id/roles` — attach one role to one user.
   *
   * Added because the bulk routes were the ONLY way to do this: the frontend's
   * only path to "assign this role to this user" was tick-a-checkbox → Bulk
   * edit → Role management, which nobody found.
   */
  async assignRole(
    userId: string,
    roleId: string,
    actor: User,
  ): Promise<{ updated: number }> {
    const role = await this.resolveRoleForActor(roleId, actor, 'assign');
    const users = await this.resolveUsersForPrivilegeWrite(
      [userId],
      actor,
      ['roles'],
    );
    return { updated: await this.applyRoleAssignment(users, role) };
  }

  /** `DELETE /users/:id/roles/:roleId` — detach one role from one user. */
  async removeRole(
    userId: string,
    roleId: string,
    actor: User,
  ): Promise<{ updated: number }> {
    const role = await this.resolveRoleForActor(roleId, actor, 'remove');
    const users = await this.resolveUsersForPrivilegeWrite(
      [userId],
      actor,
      ['roles'],
    );
    return { updated: await this.applyRoleRemoval(users, role.id) };
  }

  // ── Bulk Assign Role ──────────────────────────────────────────────────────────

  async bulkAssignRole(
    dto: BulkAssignRoleDto,
    actor: User,
  ): Promise<{ updated: number }> {
    // Both lookups are scoped and both REFUSE rather than skip. Previously
    // neither carried a tenant predicate: `roleRepository.findOne({ id })`
    // plus `userRepository.find({ id: In(ids) })` meant a tenant admin of A
    // could attach any role on the platform to any user on the platform.
    const role = await this.resolveRoleForActor(dto.roleId, actor, 'assign');
    const users = await this.resolveUsersForPrivilegeWrite(
      dto.userIds,
      actor,
      ['roles'],
    );
    return { updated: await this.applyRoleAssignment(users, role) };
  }

  // ── Bulk Remove Role ──────────────────────────────────────────────────────────

  async bulkRemoveRole(
    dto: BulkRemoveRoleDto,
    actor: User,
  ): Promise<{ updated: number }> {
    const role = await this.resolveRoleForActor(dto.roleId, actor, 'remove');
    const users = await this.resolveUsersForPrivilegeWrite(
      dto.userIds,
      actor,
      ['roles'],
    );
    return { updated: await this.applyRoleRemoval(users, role.id) };
  }

  /** The single writer behind both assign paths. */
  private async applyRoleAssignment(
    users: User[],
    role: Role,
  ): Promise<number> {
    if (users.length === 0) return 0;

    for (const user of users) {
      const alreadyAssigned = user.roles?.some((r) => r.id === role.id);
      if (!alreadyAssigned) {
        user.roles = [...(user.roles || []), role];
      }
    }

    await this.userRepository.save(users);
    // A role carries permissions, so assigning one widens what these users can
    // do. Without this the new permissions would not take effect for up to the
    // cache TTL — the less dangerous direction, but still wrong.
    await this.invalidatePermissionCache(users);

    this.eventEmitter.emit('users.role.bulk.assigned', {
      userIds: users.map((u) => u.id),
      roleId: role.id,
      roleName: role.name,
    });

    return users.length;
  }

  /** The single writer behind both remove paths. */
  private async applyRoleRemoval(
    users: User[],
    roleId: string,
  ): Promise<number> {
    if (users.length === 0) return 0;

    for (const user of users) {
      user.roles = (user.roles || []).filter((r) => r.id !== roleId);
    }

    await this.userRepository.save(users);
    // This is the dangerous direction: a revoked role whose permissions stay
    // cached is an administrator being told access was removed while it is
    // still being granted.
    await this.invalidatePermissionCache(users);

    this.eventEmitter.emit('users.role.bulk.removed', {
      userIds: users.map((u) => u.id),
      roleId,
    });

    return users.length;
  }

  // ── Bulk Send Email ───────────────────────────────────────────────────────────

  async bulkSendEmail(
    dto: BulkSendEmailDto,
    actor?: User,
  ): Promise<{ sent: number; failed: number }> {
    // Recipients confined to the caller's tenant: unscoped, this would mail
    // any user on the platform whose uuid you could paste.
    const users = await this.findByIds(dto.userIds, actor);

    if (users.length === 0) return { sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;

    await Promise.allSettled(
      users.map(async (user) => {
        try {
          await this.mailService.sendEmail({
            to: user.email,
            subject: dto.subject,
            text: dto.message,
            html: dto.htmlContent || `<p>${dto.message}</p>`,
          });
          sent++;
        } catch {
          failed++;
        }
      }),
    );

    return { sent, failed };
  }

  async bulkSendNotification(
    dto: BulkSendNotificationDto,
  ): Promise<{ sent: number }> {
    return this.notificationsService.sendBulk({
      userIds: dto.userIds,
      title: dto.title,
      message: dto.message,
      type: dto.type ?? NotificationType.SYSTEM,
      channel: NotificationChannel.IN_APP,
      priority: dto.priority ?? NotificationPriority.NORMAL,
    });
  }

  // ── Bulk Update Permissions ───────────────────────────────────────────────────

  async bulkUpdatePermissions(
    dto: BulkUpdatePermissionsDto,
    actor: User,
  ): Promise<{ updated: number }> {
    // Both sides scoped, both refusing rather than skipping — same hole as
    // bulkAssignRole: `find({ id: In(dto.userIds) })` with no tenant predicate
    // let a tenant admin of A rewrite the direct grants of any account on the
    // platform, and an unscoped permission lookup let them attach another
    // tenant's custom permission (or a platform one) while doing it.
    const permissions = await this.resolvePermissionsForActor(
      dto.permissionIds,
      actor,
      dto.operation === 'remove' ? 'revoke' : 'grant',
    );

    const users = await this.resolveUsersForPrivilegeWrite(
      dto.userIds,
      actor,
      ['directPermissions'],
    );

    if (users.length === 0) return { updated: 0 };

    for (const user of users) {
      const current = user.directPermissions || [];

      if (dto.operation === 'replace') {
        user.directPermissions = permissions;
      } else if (dto.operation === 'add') {
        const newIds = new Set(permissions.map((p) => p.id));
        const filtered = current.filter((p) => !newIds.has(p.id));
        user.directPermissions = [...filtered, ...permissions];
      } else if (dto.operation === 'remove') {
        const removeIds = new Set(dto.permissionIds);
        user.directPermissions = current.filter((p) => !removeIds.has(p.id));
      }
    }

    await this.userRepository.save(users);
    // Covers all three operations — `replace` and `remove` can both narrow a
    // user's grants, and a narrowing that is not invalidated is a revocation
    // that did not happen.
    await this.invalidatePermissionCache(users);

    return { updated: users.length };
  }

  /**
   * Bulk update user status.
   *
   * @deprecated Use PATCH /users/bulk, which returns per-id outcomes and says
   * which ids were rejected. Kept because the existing route's contract is
   * `void`; it now goes through the tenant-scoped bulkUpdate() instead of the
   * unscoped `id IN (...)` UPDATE it used to run.
   */
  async bulkUpdateStatus(
    bulkUpdateDto: BulkUpdateStatusDto,
    actor: User,
  ): Promise<void> {
    await this.bulkUpdate(
      { ids: bulkUpdateDto.userIds, status: bulkUpdateDto.status },
      actor,
    );
  }

  /**
   * Invite user.
   *
   * `InviteUserDto` carries `role` and `tenantId` just like `CreateUserDto`,
   * and this goes through `create()`, so `POST /users/invite` was the SECOND
   * way to mint a super_admin or plant an account in another tenant. Closing
   * only `POST /users` would have left the same hole one route along, which is
   * the §4g pattern that was found eight times in one pass.
   */
  async inviteUser(inviteUserDto: InviteUserDto, actor: User): Promise<User> {
    // Check if user already exists
    const existingUser = await this.findByEmail(inviteUserDto.email);
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Generate temporary password
    const tempPassword = crypto.randomBytes(16).toString('hex');

    const user = await this.create(
      {
        ...inviteUserDto,
        password: tempPassword,
      },
      actor,
    );

    // Send invitation email
    await this.mailService.sendEmail({
      to: user.email,
      subject: 'You have been invited to IoT Platform',
      text: `Welcome! Your temporary password is: ${tempPassword}. Please login and change your password.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Welcome to IoT Platform!</h2>
          <p>You have been invited to join our IoT Platform.</p>
          <p>Your temporary password: <strong>${tempPassword}</strong></p>
          <p><strong>Important:</strong> Please login and change your password immediately.</p>
          <p>Login at: <a href="${this.configService.get<string>('FRONTEND_URL')}">${this.configService.get<string>('FRONTEND_URL')}</a></p>
        </div>
      `,
    });

    // Emit event
    this.eventEmitter.emit('user.invited', { user });

    return user;
  }

  /**
   * Get user statistics
   */
  /**
   * User counts for the CALLER's scope.
   *
   * These were platform-wide: a tenant admin's dashboard reported how many
   * users every other tenant had, and how they were distributed across roles.
   * Not catastrophic, but it is competitor intelligence leaking out of a
   * statistics tile, and the fix is a predicate.
   */
  async getStatistics(actor?: User): Promise<{
    total: number;
    active: number;
    inactive: number;
    suspended: number;
    byRole: Record<UserRole, number>;
  }> {
    // `actor` is optional for internal callers; when supplied, a
    // non-super-admin is confined to their own tenant, and a tenant-less one
    // counts nothing rather than everything.
    const scope: Record<string, unknown> =
      actor && actor.role !== UserRole.SUPER_ADMIN
        ? { tenantId: actor.tenantId ?? '00000000-0000-0000-0000-000000000000' }
        : {};

    const [total, active, inactive, suspended] = await Promise.all([
      this.userRepository.count({ where: { ...scope } as any }),
      this.userRepository.count({ where: { ...scope, status: UserStatus.ACTIVE } as any }),
      this.userRepository.count({ where: { ...scope, status: UserStatus.INACTIVE } as any }),
      this.userRepository.count({ where: { ...scope, status: UserStatus.SUSPENDED } as any }),
    ]);

    // Count by role
    const rolesQb = this.userRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.role');

    if (actor && actor.role !== UserRole.SUPER_ADMIN) {
      rolesQb.where('user.tenantId = :tenantId', {
        tenantId: actor.tenantId ?? '00000000-0000-0000-0000-000000000000',
      });
    }

    const roles = await rolesQb.getRawMany();

    const byRole: any = {
      [UserRole.SUPER_ADMIN]: 0,
      [UserRole.TENANT_ADMIN]: 0,
      [UserRole.USER]: 0,
    };

    roles.forEach((row) => {
      byRole[row.role] = parseInt(row.count);
    });

    return {
      total,
      active,
      inactive,
      suspended,
      byRole,
    };
  }

  /**
   * Update last login time
   */
  async updateLastLogin(userId: string): Promise<void> {
    await this.userRepository.update(userId, {
      lastLoginAt: new Date(),
    });
  }

  /**
   * Private helper: Send verification email
   */
  private async sendVerificationEmail(user: User): Promise<void> {
    await this.mailService.sendEmail({
      to: user.email,
      subject: 'Verify Your Email',
      text: `Please verify your email using this token: ${user.emailVerificationToken}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Welcome to IoT Platform!</h2>
          <p>Please verify your email address to activate your account.</p>
          <p>Your verification token: <strong>${user.emailVerificationToken}</strong></p>
          <p>If you didn't create this account, please ignore this email.</p>
        </div>
      `,
    });
  }

  /**
   * Search users by term
   */
  /**
   * Search users the CALLER may see.
   *
   * This had no tenant predicate and no `@Roles` on its route, so any
   * authenticated account — including a customer user — could enumerate every
   * name and email address on the platform two characters at a time. A
   * directory of every tenant's staff, from a route that looks like a
   * typeahead.
   *
   * Scoped like every other read: super admin sees all, a tenant-scoped caller
   * sees their own tenant, a customer-scoped caller sees their own customer,
   * and a caller who resolves to no scope sees nothing rather than everything.
   */
  async search(term: string, actor: User, limit: number = 10): Promise<User[]> {
    const qb = this.userRepository
      .createQueryBuilder('user')
      .where('(user.name ILIKE :term OR user.email ILIKE :term)', {
        term: `%${term}%`,
      })
      .take(limit);

    if (actor.role !== UserRole.SUPER_ADMIN) {
      if (!actor.tenantId) {
        // Falsy scope denies — §4g. An omitted predicate here would widen to
        // the whole platform, which is exactly the bug being fixed.
        qb.andWhere('1 = 0');
        return qb.getMany();
      }
      qb.andWhere('user.tenantId = :tenantId', { tenantId: actor.tenantId });

      if (
        actor.role === UserRole.CUSTOMER ||
        actor.role === UserRole.CUSTOMER_USER
      ) {
        if (!actor.customerId) {
          qb.andWhere('1 = 0');
          return qb.getMany();
        }
        qb.andWhere('user.customerId = :customerId', {
          customerId: actor.customerId,
        });
      }
    }

    return qb.getMany();
  }

  /**
   * Get users by tenant
   */
  async findByTenant(tenantId: string, actor?: User): Promise<User[]> {
    // The route took the tenant from the URL unchecked, so a tenant admin
    // could list another tenant's users by editing the path. `actor` is
    // optional because internal callers pass none; when it IS supplied, a
    // non-super-admin is pinned to their own tenant whatever the URL says.
    if (actor && actor.role !== UserRole.SUPER_ADMIN) {
      if (!actor.tenantId) return [];
      if (tenantId !== actor.tenantId) {
        this.logger.warn(
          `User ${actor.id} requested users of tenant ${tenantId} — scoped to ${actor.tenantId}`,
        );
      }
      tenantId = actor.tenantId;
    }

    return await this.userRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByCustomer(customerId: string): Promise<User[]> {
    return await this.userRepository.find({
      where: { customerId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * ✅ NEW: Find users by array of IDs
   */
  /**
   * Hydrate users by id, within the caller's scope.
   *
   * Unscoped, this is the recipient list for `bulkSendEmail` — so a tenant
   * admin could mail any user on the platform by pasting uuids. `actor` is
   * optional for internal callers; supplied, it confines the result.
   */
  async findByIds(userIds: string[], actor?: User): Promise<User[]> {
    const scoped =
      actor && actor.role !== UserRole.SUPER_ADMIN
        ? { tenantId: actor.tenantId ?? '00000000-0000-0000-0000-000000000000' }
        : {};

    return await this.userRepository.find({
      where: {
        id: In(userIds),
        ...scoped,
      } as any,
      select: [
        'id',
        'email',
        'name',
        'tenantId',
        'customerId',
        'role',
        'status',
      ],
    });
  }

  /**
   * Get admin users
   */
  async findAdmins(): Promise<User[]> {
    return await this.userRepository.find({
      where: [{ role: UserRole.SUPER_ADMIN }, { role: UserRole.TENANT_ADMIN }],
    });
  }

  /**
   * Check if user exists
   */
  async exists(id: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { id } });
    return count > 0;
  }
}
