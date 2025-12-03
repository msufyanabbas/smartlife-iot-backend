// src/modules/devices/entities/device-credentials.entity.ts
// Device Credentials 

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Device } from './device.entity';

export enum CredentialsType {
  ACCESS_TOKEN = 'ACCESS_TOKEN', // Simple token-based (most common)
  MQTT_BASIC = 'MQTT_BASIC', // Username/password
  X509_CERTIFICATE = 'X509_CERTIFICATE', // Certificate-based (advanced)
}

@Entity('device_credentials')
export class DeviceCredentials {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'device_id' })
  @Index()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Device;

  @Column({
    type: 'enum',
    enum: CredentialsType,
    default: CredentialsType.ACCESS_TOKEN,
  })
  credentialsType: CredentialsType;

  /**
   * The actual credential identifier
   * - For ACCESS_TOKEN: The token itself
   * - For MQTT_BASIC: The username
   * - For X509: The certificate CN
   */
  @Column({ unique: true, name: 'credentials_id' })
  @Index()
  credentialsId: string;

  /**
   * Optional credentials value
   * - For ACCESS_TOKEN: Usually null (token is in credentialsId)
   * - For MQTT_BASIC: Encrypted password
   * - For X509: Certificate fingerprint
   */
  @Column({ nullable: true, name: 'credentials_value' })
  credentialsValue?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Generate a random access token
   */
  static generateAccessToken(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }
}
