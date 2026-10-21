import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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

  /**
   * Create a new user
   */
  async create(createUserDto: CreateUserDto): Promise<User> {
    // Check if user already exists
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
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

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
  async remove(id: string): Promise<void> {
    const user = await this.findOne(id);

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
  async updateStatus(userId: string, status: UserStatus): Promise<User> {
    const user = await this.findOne(userId);
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
    const rows: Array<{ id: string }> = await this.dataSource.query(
      actor.tenantId
        ? `SELECT id FROM customers WHERE id = $1 AND "tenantId" = $2 AND deleted_at IS NULL`
        : `SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL`,
      actor.tenantId ? [customerId, actor.tenantId] : [customerId],
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

  // ── Bulk Assign Role ──────────────────────────────────────────────────────────

  async bulkAssignRole(dto: BulkAssignRoleDto): Promise<{ updated: number }> {
    const role = await this.roleRepository.findOne({
      where: { id: dto.roleId },
      relations: ['permissions'],
    });

    if (!role) throw new NotFoundException(`Role ${dto.roleId} not found`);

    const users = await this.userRepository.find({
      where: { id: In(dto.userIds) },
      relations: ['roles'],
    });

    if (users.length === 0) return { updated: 0 };

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

    return { updated: users.length };
  }

  // ── Bulk Remove Role ──────────────────────────────────────────────────────────

  async bulkRemoveRole(dto: BulkRemoveRoleDto): Promise<{ updated: number }> {
    const users = await this.userRepository.find({
      where: { id: In(dto.userIds) },
      relations: ['roles'],
    });

    if (users.length === 0) return { updated: 0 };

    for (const user of users) {
      user.roles = (user.roles || []).filter((r) => r.id !== dto.roleId);
    }

    await this.userRepository.save(users);
    // This is the dangerous direction: a revoked role whose permissions stay
    // cached is an administrator being told access was removed while it is
    // still being granted.
    await this.invalidatePermissionCache(users);

    this.eventEmitter.emit('users.role.bulk.removed', {
      userIds: users.map((u) => u.id),
      roleId: dto.roleId,
    });

    return { updated: users.length };
  }

  // ── Bulk Send Email ───────────────────────────────────────────────────────────

  async bulkSendEmail(
    dto: BulkSendEmailDto,
  ): Promise<{ sent: number; failed: number }> {
    const users = await this.findByIds(dto.userIds);

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
  ): Promise<{ updated: number }> {
    const users = await this.userRepository.find({
      where: { id: In(dto.userIds) },
      relations: ['directPermissions'],
    });

    if (users.length === 0) return { updated: 0 };

    const permissions = await this.permissionRepository.find({
      where: { id: In(dto.permissionIds) },
    });

    if (permissions.length !== dto.permissionIds.length) {
      throw new BadRequestException('One or more permission IDs are invalid');
    }

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
   * Invite user
   */
  async inviteUser(inviteUserDto: InviteUserDto): Promise<User> {
    // Check if user already exists
    const existingUser = await this.findByEmail(inviteUserDto.email);
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Generate temporary password
    const tempPassword = crypto.randomBytes(16).toString('hex');

    const user = await this.create({
      ...inviteUserDto,
      password: tempPassword,
    });

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
  async getStatistics(): Promise<{
    total: number;
    active: number;
    inactive: number;
    suspended: number;
    byRole: Record<UserRole, number>;
  }> {
    const [total, active, inactive, suspended] = await Promise.all([
      this.userRepository.count(),
      this.userRepository.count({ where: { status: UserStatus.ACTIVE } }),
      this.userRepository.count({ where: { status: UserStatus.INACTIVE } }),
      this.userRepository.count({ where: { status: UserStatus.SUSPENDED } }),
    ]);

    // Count by role
    const roles = await this.userRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.role')
      .getRawMany();

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
  async search(term: string, limit: number = 10): Promise<User[]> {
    return await this.userRepository.find({
      where: [{ name: Like(`%${term}%`) }, { email: Like(`%${term}%`) }],
      take: limit,
    });
  }

  /**
   * Get users by tenant
   */
  async findByTenant(tenantId: string): Promise<User[]> {
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
  async findByIds(userIds: string[]): Promise<User[]> {
    return await this.userRepository.find({
      where: {
        id: In(userIds),
      },
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
