import {
  Entity,
  Column,
  OneToOne,
  JoinColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Device } from './device.entity';
import * as crypto from 'crypto';

export enum CredentialsType {
  ACCESS_TOKEN = 'ACCESS_TOKEN',
  MQTT_BASIC = 'MQTT_BASIC',
  X509_CERTIFICATE = 'X509_CERTIFICATE',
}

@Entity('device_credentials')
@Index(['deviceId'], { unique: true }) // One credential set per device
@Index(['credentialsId'], { unique: true }) // Used for fast auth lookup
export class DeviceCredentials extends BaseEntity {
  // ── Device relationship (1:1) ─────────────────────────────────────────────
  // CASCADE DELETE is handled at the DB level via onDelete: 'CASCADE'.
  // Do NOT add TypeORM cascade: ['remove'] here — it causes a double-delete
  // when the parent Device is soft-removed and credentials are also deleted
  // manually by DeviceCredentialsService.deleteByDeviceId().

  @Column()
  deviceId: string;

  @OneToOne(() => Device, (device) => device.credentials, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  // ── Credentials type ──────────────────────────────────────────────────────

  @Column({
    type: 'enum',
    enum: CredentialsType,
    default: CredentialsType.ACCESS_TOKEN,
  })
  credentialsType: CredentialsType;

  // ── Credential identifier ─────────────────────────────────────────────────
  // For ACCESS_TOKEN → the token itself (used as MQTT username)
  // For MQTT_BASIC   → the username
  // For X509         → the certificate CN

  @Column({ unique: true })
  credentialsId: string;

  // ── Credential value ──────────────────────────────────────────────────────
  // For ACCESS_TOKEN → null  (token is self-contained in credentialsId)
  // For MQTT_BASIC   → the password (stored hashed in production; plain for now)
  // For X509         → certificate fingerprint
  //
  // IMPORTANT: select: false means this column is NOT returned by default
  // QueryBuilder / findOne calls.  Any service method that needs credentialsValue
  // MUST add `.addSelect('credentials.credentialsValue')` explicitly.

  @Column({ type: 'text', nullable: true, select: false })
  credentialsValue?: string;

  // ── Metadata ──────────────────────────────────────────────────────────────

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;

  @Column({ default: true })
  isActive: boolean;

  // ── Static helpers ────────────────────────────────────────────────────────

  /** Cryptographically secure token — 48 random bytes → 64-char hex string */
  static generateToken(): string {
    return crypto.randomBytes(48).toString('hex');
  }

  /** Simple random string for human-readable IDs */
  static generateRandomString(length: number): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length)),
    ).join('');
  }

  // ── Instance helpers ──────────────────────────────────────────────────────

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return this.isActive && !this.isExpired();
  }

  recordUsage(): void {
    this.lastUsedAt = new Date();
  }

  revoke(): void {
    this.isActive = false;
  }
}