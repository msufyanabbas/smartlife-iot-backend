// src/modules/devices/entities/device-credentials.entity.ts
import { Entity, Column, ManyToOne, OneToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Device } from './device.entity';

export enum CredentialsType {
  ACCESS_TOKEN = 'ACCESS_TOKEN',
  MQTT_BASIC = 'MQTT_BASIC',
  X509_CERTIFICATE = 'X509_CERTIFICATE',
}

@Entity('device_credentials')
@Index(['deviceId'], { unique: true })  // Ensure one credential per device
export class DeviceCredentials extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE RELATIONSHIP (1:1)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  deviceId: string;

  @OneToOne(() => Device, device => device.credentials, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  // ══════════════════════════════════════════════════════════════════════════
  // CREDENTIALS TYPE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({
    type: 'enum',
    enum: CredentialsType,
    default: CredentialsType.ACCESS_TOKEN,
  })

  credentialsType: CredentialsType;

  // ══════════════════════════════════════════════════════════════════════════
  // CREDENTIALS DATA
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The actual credential identifier
   * - For ACCESS_TOKEN: The token itself
   * - For MQTT_BASIC: The username
   * - For X509: The certificate CN
   */
  @Column({ unique: true })

  credentialsId: string;

  /**
   * Optional credentials value
   * - For ACCESS_TOKEN: Usually null (token is in credentialsId)
   * - For MQTT_BASIC: Encrypted password
   * - For X509: Certificate fingerprint
   */
  @Column({ type: 'text', nullable: true, select: false })  // ← Added select: false for security
  credentialsValue?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date;  // Track when credentials were last used

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;  // Optional expiration for tokens

  @Column({ default: true })

  isActive: boolean;  // Can disable credentials without deleting

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a random access token
   */
  static generateAccessToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  /**
   * Check if credentials are expired
   */
  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  /**
   * Check if credentials are valid
   */
  isValid(): boolean {
    return this.isActive && !this.isExpired();
  }

  /**
   * Record usage
   */
  recordUsage(): void {
    this.lastUsedAt = new Date();
  }

  /**
   * Revoke credentials
   */
  revoke(): void {
    this.isActive = false;
  }
}