import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { TwoFactorAuth, TwoFactorMethod } from './entities/two-factor-auth.entity';
import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwoFactorAuthService {
  private readonly logger = new Logger(TwoFactorAuthService.name);

  constructor(
    @InjectRepository(TwoFactorAuth)
    private twoFactorAuthRepository: Repository<TwoFactorAuth>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private mailService: MailService,
    private configService: ConfigService,
  ) {}

  /**
   * Get or create 2FA record for user
   */
  async getOrCreate(userId: string): Promise<TwoFactorAuth> {
    let twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    if (!twoFactor) {
      twoFactor = this.twoFactorAuthRepository.create({ userId });
      await this.twoFactorAuthRepository.save(twoFactor);
    }

    return twoFactor;
  }

  /**
   * Check if user has 2FA enabled
   */
  async isEnabled(userId: string): Promise<boolean> {
    const twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    return twoFactor?.isEnabled || false;
  }

  /**
   * Get user's 2FA settings
   */
  async getSettings(userId: string): Promise<any> {
    const twoFactor = await this.getOrCreate(userId);

    return {
      isEnabled: twoFactor.isEnabled,
      method: twoFactor.method,
      phoneNumber: twoFactor.phoneNumber
        ? this.maskPhoneNumber(twoFactor.phoneNumber)
        : null,
      phoneVerified: twoFactor.phoneVerified,
      hasBackupCodes: !!twoFactor.backupCodes,
    };
  }

  // ==================== AUTHENTICATOR (TOTP) ====================

  /**
   * Generate TOTP secret and QR code for authenticator app
   */
  async generateAuthenticatorSecret(userId: string): Promise<{
    secret: string;
    qrCode: string;
    manualEntryKey: string;
  }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const secret = speakeasy.generateSecret({
      name: `${this.configService.get('APP_NAME', 'SmartLife IoT')} (${user.email})`,
      issuer: this.configService.get('APP_NAME', 'SmartLife IoT'),
      length: 32,
    });

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url!);

    // Save temporary secret (not enabled yet)
    const twoFactor = await this.getOrCreate(userId);
    twoFactor.secret = secret.base32;
    await this.twoFactorAuthRepository.save(twoFactor);

    return {
      secret: secret.base32,
      qrCode,
      manualEntryKey: secret.base32,
    };
  }

  /**
   * Verify TOTP code from authenticator app
   */
  async verifyAuthenticatorCode(userId: string, code: string): Promise<boolean> {
    const twoFactor = await this.getOrCreate(userId);

    if (!twoFactor.secret) {
      throw new BadRequestException('Authenticator not set up');
    }

    const verified = speakeasy.totp.verify({
      secret: twoFactor.secret,
      encoding: 'base32',
      token: code,
      window: 2, // Allow 2 time steps before/after
    });

    return verified;
  }

  /**
   * Enable authenticator 2FA
   */
  async enableAuthenticator(userId: string, code: string): Promise<{
    backupCodes: string[];
    message: string;
  }> {
    const verified = await this.verifyAuthenticatorCode(userId, code);

    if (!verified) {
      throw new BadRequestException('Invalid verification code');
    }

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    // Hash backup codes for storage
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    // Enable 2FA
    const twoFactor = await this.getOrCreate(userId);
    twoFactor.isEnabled = true;
    twoFactor.method = TwoFactorMethod.AUTHENTICATOR;
    twoFactor.backupCodes = JSON.stringify(hashedBackupCodes);
    twoFactor.enabledAt = new Date();
    await this.twoFactorAuthRepository.save(twoFactor);

    this.logger.log(`Authenticator 2FA enabled for user ${userId}`);

    return {
      backupCodes,
      message: 'Authenticator 2FA enabled successfully. Save these backup codes in a safe place.',
    };
  }

  // ==================== SMS ====================

  /**
   * Setup SMS 2FA
   */
  async setupSMS(userId: string, phoneNumber: string): Promise<{ message: string }> {
    // Validate phone number format (basic validation)
    if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
      throw new BadRequestException('Invalid phone number format');
    }

    const twoFactor = await this.getOrCreate(userId);
    twoFactor.phoneNumber = phoneNumber;
    twoFactor.phoneVerified = false;
    await this.twoFactorAuthRepository.save(twoFactor);

    // Send verification code
    await this.sendSMSCode(userId);

    return {
      message: 'Verification code sent to your phone number',
    };
  }

  /**
   * Send SMS verification code
   */
  async sendSMSCode(userId: string): Promise<void> {
    const twoFactor = await this.getOrCreate(userId);

    if (!twoFactor.phoneNumber) {
      throw new BadRequestException('Phone number not configured');
    }

    // Generate 6-digit code
    const code = this.generateNumericCode(6);
    const hashedCode = await bcrypt.hash(code, 10);

    // Save code with 10-minute expiry
    twoFactor.tempCode = hashedCode;
    twoFactor.tempCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);
    twoFactor.tempCodeAttempts = 0;
    await this.twoFactorAuthRepository.save(twoFactor);

    // TODO: Integrate with SMS provider (Twilio, AWS SNS, etc.)
    // For now, log the code (REMOVE IN PRODUCTION)
    this.logger.warn(`SMS code for user ${userId}: ${code}`);
    
    // In production, send via SMS:
    // await this.smsService.send(twoFactor.phoneNumber, `Your verification code is: ${code}`);

    this.logger.log(`SMS code sent to ${this.maskPhoneNumber(twoFactor.phoneNumber)}`);
  }

  /**
   * Verify SMS code and enable SMS 2FA
   */
  async enableSMS(userId: string, code: string): Promise<{
    backupCodes: string[];
    message: string;
  }> {
    const twoFactor = await this.getOrCreate(userId);

    if (!twoFactor.phoneNumber) {
      throw new BadRequestException('Phone number not configured');
    }

    if (twoFactor.isLocked()) {
      throw new BadRequestException('Too many failed attempts. Please try again later.');
    }

    if (!twoFactor.isTempCodeValid()) {
      throw new BadRequestException('Verification code expired. Please request a new one.');
    }

    const isValid = await bcrypt.compare(code, twoFactor.tempCode!);

    if (!isValid) {
      twoFactor.incrementAttempts();
      await this.twoFactorAuthRepository.save(twoFactor);
      throw new BadRequestException('Invalid verification code');
    }

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    // Enable 2FA
    twoFactor.isEnabled = true;
    twoFactor.method = TwoFactorMethod.SMS;
    twoFactor.phoneVerified = true;
    twoFactor.backupCodes = JSON.stringify(hashedBackupCodes);
    twoFactor.tempCode = undefined;
    twoFactor.tempCodeExpiry = undefined;
    twoFactor.resetAttempts();
    twoFactor.enabledAt = new Date();
    await this.twoFactorAuthRepository.save(twoFactor);

    this.logger.log(`SMS 2FA enabled for user ${userId}`);

    return {
      backupCodes,
      message: 'SMS 2FA enabled successfully. Save these backup codes in a safe place.',
    };
  }

  // ==================== EMAIL ====================

  /**
   * Send email verification code
   */
  async sendEmailCode(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const twoFactor = await this.getOrCreate(userId);

    // Generate 6-digit code
    const code = this.generateNumericCode(6);
    const hashedCode = await bcrypt.hash(code, 10);

    // Save code with 10-minute expiry
    twoFactor.tempCode = hashedCode;
    twoFactor.tempCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);
    twoFactor.tempCodeAttempts = 0;
    await this.twoFactorAuthRepository.save(twoFactor);

    // Send email
    try {
      await this.mailService.sendTwoFactorCode(user.email, user.name, code);
      this.logger.log(`Email 2FA code sent to ${user.email}`);
    } catch (error) {
      this.logger.error(`Failed to send 2FA email to ${user.email}:`, error);
      throw new BadRequestException('Failed to send verification code');
    }
  }

  /**
   * Enable email 2FA
   */
  async enableEmail(userId: string, code: string): Promise<{
    backupCodes: string[];
    message: string;
  }> {
    const twoFactor = await this.getOrCreate(userId);

    if (twoFactor.isLocked()) {
      throw new BadRequestException('Too many failed attempts. Please try again later.');
    }

    if (!twoFactor.isTempCodeValid()) {
      throw new BadRequestException('Verification code expired. Please request a new one.');
    }

    const isValid = await bcrypt.compare(code, twoFactor.tempCode!);

    if (!isValid) {
      twoFactor.incrementAttempts();
      await this.twoFactorAuthRepository.save(twoFactor);
      throw new BadRequestException('Invalid verification code');
    }

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    // Enable 2FA
    twoFactor.isEnabled = true;
    twoFactor.method = TwoFactorMethod.EMAIL;
    twoFactor.backupCodes = JSON.stringify(hashedBackupCodes);
    twoFactor.tempCode = undefined;
    twoFactor.tempCodeExpiry = undefined;
    twoFactor.resetAttempts();
    twoFactor.enabledAt = new Date();
    await this.twoFactorAuthRepository.save(twoFactor);

    this.logger.log(`Email 2FA enabled for user ${userId}`);

    return {
      backupCodes,
      message: 'Email 2FA enabled successfully. Save these backup codes in a safe place.',
    };
  }

  // ==================== VERIFICATION (Used during login) ====================

  /**
   * Verify 2FA code during login
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    if (!twoFactor || !twoFactor.isEnabled) {
      throw new BadRequestException('2FA is not enabled');
    }

    // Check if it's a backup code first
    if (await this.verifyBackupCode(userId, code)) {
      return true;
    }

    // Verify based on method
    switch (twoFactor.method) {
      case TwoFactorMethod.AUTHENTICATOR:
        return await this.verifyAuthenticatorCode(userId, code);

      case TwoFactorMethod.SMS:
      case TwoFactorMethod.EMAIL:
        if (twoFactor.isLocked()) {
          throw new UnauthorizedException('Too many failed attempts');
        }

        if (!twoFactor.isTempCodeValid()) {
          throw new UnauthorizedException('Verification code expired');
        }

        const isValid = await bcrypt.compare(code, twoFactor.tempCode!);

        if (!isValid) {
          twoFactor.incrementAttempts();
          await this.twoFactorAuthRepository.save(twoFactor);
          throw new UnauthorizedException('Invalid verification code');
        }

        // Clear temp code after successful verification
        twoFactor.tempCode = undefined;
        twoFactor.tempCodeExpiry = undefined;
        twoFactor.resetAttempts();
        twoFactor.lastVerifiedAt = new Date();
        await this.twoFactorAuthRepository.save(twoFactor);

        return true;

      default:
        throw new BadRequestException('Invalid 2FA method');
    }
  }

  /**
   * Verify backup code
   */
  async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    if (!twoFactor?.backupCodes) {
      return false;
    }

    const backupCodes: string[] = JSON.parse(twoFactor.backupCodes);

    for (let i = 0; i < backupCodes.length; i++) {
      const isMatch = await bcrypt.compare(code, backupCodes[i]);
      if (isMatch) {
        // Remove used backup code
        backupCodes.splice(i, 1);
        twoFactor.backupCodes = JSON.stringify(backupCodes);
        twoFactor.lastVerifiedAt = new Date();
        await this.twoFactorAuthRepository.save(twoFactor);

        this.logger.log(`Backup code used for user ${userId}. Remaining: ${backupCodes.length}`);
        return true;
      }
    }

    return false;
  }

  // ==================== DISABLE 2FA ====================

  /**
   * Disable 2FA
   */
  async disable(userId: string, code: string): Promise<{ message: string }> {
    const verified = await this.verifyCode(userId, code);

    if (!verified) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    if (twoFactor) {
      twoFactor.isEnabled = false;
      twoFactor.method = undefined;
      twoFactor.secret = undefined;
      twoFactor.backupCodes = undefined;
      twoFactor.tempCode = undefined;
      twoFactor.tempCodeExpiry = undefined;
      await this.twoFactorAuthRepository.save(twoFactor);
    }

    this.logger.log(`2FA disabled for user ${userId}`);

    return {
      message: '2FA has been disabled',
    };
  }

  // ==================== HELPER METHODS ====================

  /**
   * Generate backup codes
   */
  private generateBackupCodes(count: number = 10): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      codes.push(this.generateAlphanumericCode(8));
    }
    return codes;
  }

  /**
   * Generate numeric code
   */
  private generateNumericCode(length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += Math.floor(Math.random() * 10);
    }
    return code;
  }

  /**
   * Generate alphanumeric code
   */
  private generateAlphanumericCode(length: number): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar looking chars
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    return code;
  }

  /**
   * Mask phone number for display
   */
  private maskPhoneNumber(phone: string): string {
    if (phone.length <= 4) return phone;
    return phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4);
  }

  /**
   * Regenerate backup codes
   */
  async regenerateBackupCodes(userId: string, verificationCode: string): Promise<{
    backupCodes: string[];
    message: string;
  }> {
    const verified = await this.verifyCode(userId, verificationCode);

    if (!verified) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const twoFactor = await this.twoFactorAuthRepository.findOne({
      where: { userId },
    });

    if (!twoFactor?.isEnabled) {
      throw new BadRequestException('2FA is not enabled');
    }

    // Generate new backup codes
    const backupCodes = this.generateBackupCodes();
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    twoFactor.backupCodes = JSON.stringify(hashedBackupCodes);
    await this.twoFactorAuthRepository.save(twoFactor);

    this.logger.log(`Backup codes regenerated for user ${userId}`);

    return {
      backupCodes,
      message: 'Backup codes regenerated successfully',
    };
  }
}