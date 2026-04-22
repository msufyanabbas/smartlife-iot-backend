// src/database/seeds/device-credentials/device-credentials.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceType } from '@common/enums/index.enum';
import {
  DeviceCredentials,
  CredentialsType,
} from '@modules/devices/entities/device-credentials.entity';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class DeviceCredentialsSeeder implements ISeeder {
  private readonly logger = new Logger(DeviceCredentialsSeeder.name);

  constructor(
    @InjectRepository(DeviceCredentials)
    private readonly credentialsRepository: Repository<DeviceCredentials>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting device credentials seeding...');

    // Check if credentials already exist
    const existingCredentials = await this.credentialsRepository.count();
    if (existingCredentials > 0) {
      this.logger.log(
        `⏭️  Device credentials already seeded (${existingCredentials} records). Skipping...`,
      );
      return;
    }

    // Fetch all devices
    const devices = await this.deviceRepository.find();

    if (devices.length === 0) {
      this.logger.warn('⚠️  No devices found. Please seed devices first.');
      return;
    }

    this.logger.log(`📊 Found ${devices.length} devices to create credentials for`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const generateMqttUsername = (deviceName: string): string => {
      return deviceName.toLowerCase().replace(/\s+/g, '_');
    };

    const generateEncryptedPassword = (password: string): string => {
      // In production, use proper encryption (e.g., bcrypt)
      return crypto.createHash('sha256').update(password).digest('hex');
    };

    const generateCertificateCN = (deviceName: string): string => {
      return `CN=${deviceName.replace(/\s+/g, '_')}.device.smartlife.local`;
    };

    const generateCertificateFingerprint = (): string => {
      return Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0'),
      )
        .join(':')
        .toUpperCase();
    };

    // ════════════════════════════════════════════════════════════════
    // CREDENTIAL TYPE DISTRIBUTION BY DEVICE TYPE
    // ════════════════════════════════════════════════════════════════

    const getCredentialType = (deviceType: DeviceType): CredentialsType => {
      const rand = Math.random();

      switch (deviceType) {
        case DeviceType.SENSOR:
          return rand < 0.9 ? CredentialsType.ACCESS_TOKEN : CredentialsType.MQTT_BASIC;

        case DeviceType.GATEWAY:
          return rand < 0.4 ? CredentialsType.X509_CERTIFICATE :
            rand < 0.8 ? CredentialsType.MQTT_BASIC :
              CredentialsType.ACCESS_TOKEN;

        case DeviceType.CONTROLLER:
          return rand < 0.5 ? CredentialsType.ACCESS_TOKEN : CredentialsType.MQTT_BASIC;

        case DeviceType.ACTUATOR:
          return rand < 0.7 ? CredentialsType.MQTT_BASIC : CredentialsType.ACCESS_TOKEN;

        case DeviceType.CAMERA:
          return rand < 0.8 ? CredentialsType.MQTT_BASIC : CredentialsType.ACCESS_TOKEN;

        case DeviceType.TRACKER:
          return rand < 0.9 ? CredentialsType.ACCESS_TOKEN : CredentialsType.MQTT_BASIC;

        default:
          return CredentialsType.ACCESS_TOKEN;
      }
    };

    // ════════════════════════════════════════════════════════════════
    // CREATE CREDENTIALS FOR EACH DEVICE
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;
    const summary = {
      byType: {} as Record<string, number>,
      total: 0,
    };

    for (const device of devices) {
      try {
        const credentialsType = getCredentialType(device.type);
        let credentialsId: string;
        let credentialsValue: string | undefined;

        // Generate credentials based on type
        switch (credentialsType) {
          case CredentialsType.ACCESS_TOKEN:
            credentialsId = DeviceCredentials.generateToken();
            credentialsValue = undefined;
            break;

          case CredentialsType.MQTT_BASIC:
            credentialsId = generateMqttUsername(device.name);
            const password = `${device.name.substring(0, 4).toLowerCase()}${Math.floor(Math.random() * 10000)}`;
            credentialsValue = generateEncryptedPassword(password);
            break;

          case CredentialsType.X509_CERTIFICATE:
            credentialsId = generateCertificateCN(device.name);
            credentialsValue = generateCertificateFingerprint();
            break;

          default:
            credentialsId = DeviceCredentials.generateToken();
            credentialsValue = undefined;
        }

        // Create credentials
        const credentials = this.credentialsRepository.create({
          deviceId: device.id,
          credentialsType,
          credentialsId,
          credentialsValue,
          isActive: true,
          lastUsedAt: Math.random() > 0.5 ? new Date() : undefined,
        });

        await this.credentialsRepository.save(credentials);

        summary.byType[credentialsType] = (summary.byType[credentialsType] || 0) + 1;
        createdCount++;

        const typeTag =
          credentialsType === CredentialsType.ACCESS_TOKEN ? '🔑 TOKEN' :
            credentialsType === CredentialsType.MQTT_BASIC ? '👤 MQTT' :
              '📜 X509';

        this.logger.log(
          `✅ Created: ${device.name.substring(0, 35).padEnd(37)} | ${typeTag}`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to create credentials for ${device.name}: ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    this.logger.log('');
    this.logger.log(
      `🎉 Device credentials seeding complete! Created ${createdCount}/${devices.length} credentials.`,
    );
    this.logger.log('');
    this.logger.log('📊 Credentials Summary:');
    this.logger.log(`   Total: ${createdCount}`);
    this.logger.log('');
    this.logger.log('   By Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(20)}: ${count}`),
    );

    // Display sample credentials for testing
    this.logger.log('');
    this.logger.log('📋 Sample Credentials for Testing (First 3):');
    const sampleCredentials = await this.credentialsRepository.find({
      take: 3,
      relations: ['device'],
      order: { createdAt: 'DESC' },
    });

    for (const cred of sampleCredentials) {
      this.logger.log('');
      this.logger.log(`   Device: ${cred.device.name}`);
      this.logger.log(`   Type: ${cred.credentialsType}`);
      this.logger.log(`   ID: ${cred.credentialsId}`);
      if (cred.credentialsValue && cred.credentialsType !== CredentialsType.ACCESS_TOKEN) {
        this.logger.log(`   Value: ${cred.credentialsValue.substring(0, 20)}...`);
      }
    }
  }
}