import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device, DeviceType } from '@modules/devices/entities/device.entity';
import {
  DeviceCredentials,
  CredentialsType,
} from '@modules/devices/entities/device-credentials.entity';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class DeviceCredentialsSeeder implements ISeeder {
  constructor(
    @InjectRepository(DeviceCredentials)
    private readonly credentialsRepository: Repository<DeviceCredentials>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all devices
    const devices = await this.deviceRepository.find();

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    console.log(
      `📡 Found ${devices.length} devices to create credentials for...`,
    );

    // Helper function to generate MQTT username
    const generateMqttUsername = (deviceName: string): string => {
      return deviceName.toLowerCase().replace(/\s+/g, '_');
    };

    // Helper function to generate encrypted password (simplified for seeding)
    const generateEncryptedPassword = (password: string): string => {
      // In production, use proper encryption (e.g., bcrypt)
      // For seeding purposes, we'll use a simple hash
      return crypto.createHash('sha256').update(password).digest('hex');
    };

    // Helper function to generate certificate CN
    const generateCertificateCN = (deviceName: string): string => {
      return `CN=${deviceName.replace(/\s+/g, '_')}.device.local`;
    };

    // Helper function to generate certificate fingerprint
    const generateCertificateFingerprint = (): string => {
      return Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0'),
      )
        .join(':')
        .toUpperCase();
    };

    // Credential type distribution strategy:
    // - Sensors: Mostly ACCESS_TOKEN (90%), some MQTT_BASIC (10%)
    // - Gateways: Mix of MQTT_BASIC (60%) and X509 (40%)
    // - Controllers: Mix of ACCESS_TOKEN (50%) and MQTT_BASIC (50%)
    // - Actuators: Mostly MQTT_BASIC (70%), some ACCESS_TOKEN (30%)
    // - Cameras: Mostly MQTT_BASIC (80%), some ACCESS_TOKEN (20%)
    // - Trackers: Mostly ACCESS_TOKEN (90%), some MQTT_BASIC (10%)

    let credentialsCreated = 0;
    let credentialsSkipped = 0;

    for (const device of devices) {
      // Check if credentials already exist for this device
      const existing = await this.credentialsRepository.findOne({
        where: { deviceId: device.id },
      });

      if (existing) {
        console.log(`⏭️  Credentials already exist for device: ${device.name}`);
        credentialsSkipped++;
        continue;
      }

      let credentialsType: CredentialsType;
      let credentialsId: string;
      let credentialsValue: string | undefined;

      // Determine credential type based on device type
      switch (device.type) {
        case DeviceType.SENSOR:
          credentialsType =
            Math.random() < 0.9
              ? CredentialsType.ACCESS_TOKEN
              : CredentialsType.MQTT_BASIC;
          break;

        case DeviceType.GATEWAY:
          credentialsType =
            Math.random() < 0.6
              ? CredentialsType.MQTT_BASIC
              : CredentialsType.X509_CERTIFICATE;
          break;

        case DeviceType.CONTROLLER:
          credentialsType =
            Math.random() < 0.5
              ? CredentialsType.ACCESS_TOKEN
              : CredentialsType.MQTT_BASIC;
          break;

        case DeviceType.ACTUATOR:
          credentialsType =
            Math.random() < 0.7
              ? CredentialsType.MQTT_BASIC
              : CredentialsType.ACCESS_TOKEN;
          break;

        case DeviceType.CAMERA:
          credentialsType =
            Math.random() < 0.8
              ? CredentialsType.MQTT_BASIC
              : CredentialsType.ACCESS_TOKEN;
          break;

        case DeviceType.TRACKER:
          credentialsType =
            Math.random() < 0.9
              ? CredentialsType.ACCESS_TOKEN
              : CredentialsType.MQTT_BASIC;
          break;

        default:
          credentialsType = CredentialsType.ACCESS_TOKEN;
      }

      // Generate credentials based on type
      switch (credentialsType) {
        case CredentialsType.ACCESS_TOKEN:
          credentialsId = DeviceCredentials.generateAccessToken();
          credentialsValue = undefined;
          break;

        case CredentialsType.MQTT_BASIC:
          credentialsId = generateMqttUsername(device.name);
          // Generate a simple password for demo purposes
          const password = `${device.name.substring(0, 4).toLowerCase()}${Math.floor(Math.random() * 10000)}`;
          credentialsValue = generateEncryptedPassword(password);
          break;

        case CredentialsType.X509_CERTIFICATE:
          credentialsId = generateCertificateCN(device.name);
          credentialsValue = generateCertificateFingerprint();
          break;

        default:
          credentialsId = DeviceCredentials.generateAccessToken();
          credentialsValue = undefined;
      }

      // Create and save credentials
      const credentials = this.credentialsRepository.create({
        deviceId: device.id,
        device: device,
        credentialsType,
        credentialsId,
        credentialsValue,
      });

      try {
        await this.credentialsRepository.save(credentials);
        console.log(
          `✅ Created ${credentialsType} credentials for: ${device.name}`,
        );
        credentialsCreated++;
      } catch (error) {
        console.error(
          `❌ Failed to create credentials for ${device.name}:`,
          error.message,
        );
      }
    }

    console.log('\n📊 Device Credentials Seeding Summary:');
    console.log(`   ✅ Created: ${credentialsCreated}`);
    console.log(`   ⏭️  Skipped: ${credentialsSkipped}`);
    console.log(`   📱 Total Devices: ${devices.length}`);
    console.log('\n🎉 Device credentials seeding completed!');

    // Display sample credentials for testing
    console.log('\n📋 Sample Credentials for Testing:');
    const sampleCredentials = await this.credentialsRepository.find({
      take: 5,
      relations: ['device'],
      order: { createdAt: 'DESC' },
    });

    for (const cred of sampleCredentials) {
      console.log(`\n   Device: ${cred.device.name}`);
      console.log(`   Type: ${cred.credentialsType}`);
      console.log(`   ID: ${cred.credentialsId}`);
      if (cred.credentialsValue) {
        console.log(`   Value: ${cred.credentialsValue.substring(0, 20)}...`);
      }
    }
  }
}
