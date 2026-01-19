import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { User, UserRole, UserStatus } from './entities/user.entity';
import {
  CreateUserDto,
  UpdateUserDto,
  ChangePasswordDto,
  ResetPasswordDto,
  ForgotPasswordDto,
  UpdatePreferencesDto,
  BulkUpdateStatusDto,
  InviteUserDto,
} from './dto/users.dto';
import { MailService } from '../../modules/mail/mail.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private eventEmitter: EventEmitter2,
    private mailService: MailService,
  ) {}

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

    // Send verification email
    await this.sendVerificationEmail(savedUser);

    // Emit event
    this.eventEmitter.emit('user.created', { user: savedUser });

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
  }): Promise<{
    users: User[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
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

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find one user by ID
   */
  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
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

    Object.assign(user, updateUserDto);

    const updatedUser = await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('user.updated', { user: updatedUser });

    return updatedUser;
  }

  /**
   * Delete user (soft delete)
   */
  async remove(id: string): Promise<void> {
    const user = await this.findOne(id);

    await this.userRepository.softRemove(user);

    // Emit event
    this.eventEmitter.emit('user.deleted', { userId: id });
  }

  /**
   * Change password
   */
  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
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

    // Emit event
    this.eventEmitter.emit('user.password.changed', { userId });

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
  async forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<void> {
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
  async resetPassword(resetPasswordDto: ResetPasswordDto): Promise<void> {
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
      status,
      previousStatus: user.status,
    });

    return updatedUser;
  }

  /**
   * Bulk update user status
   */
  async bulkUpdateStatus(bulkUpdateDto: BulkUpdateStatusDto): Promise<void> {
    await this.userRepository.update(
      { id: In(bulkUpdateDto.userIds) },
      { status: bulkUpdateDto.status },
    );

    // Emit event
    this.eventEmitter.emit('users.status.bulk.updated', {
      userIds: bulkUpdateDto.userIds,
      status: bulkUpdateDto.status,
    });
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
          <p>Login at: <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}">${process.env.FRONTEND_URL || 'http://localhost:3000'}</a></p>
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
