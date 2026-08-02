// src/database/seeds/device.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceType, DeviceStatus, DeviceConnectionType } from '@common/enums/index.enum';
import {
  DeviceCredentials,
  CredentialsType,
} from '@modules/devices/entities/device-credentials.entity';
import { User } from '@modules/users/entities/user.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { ISeeder } from '../seeder.interface';
import { randomUUID } from 'crypto';

@Injectable()
export class DeviceSeeder implements ISeeder {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,

    @InjectRepository(DeviceCredentials)
    private readonly credentialsRepository: Repository<DeviceCredentials>,
  ) {}

  /**
   * Give a device an ACCESS_TOKEN credential set if it has none.
   *
   * Mirrors DeviceCredentialsService.createCredentials() — same
   * `{deviceKey}_{token}` shape — so a seeded device authenticates exactly
   * like one created through POST /devices.
   *
   * DeviceCredentialsSeeder (position 32 in SEEDERS, vs 4 for this one) also
   * assigns credentials, with a varied type mix for demo data. Because it now
   * gap-fills rather than bailing out, it simply finds nothing to do for the
   * devices seeded here — these end up ACCESS_TOKEN across the board.
   *
   * Idempotent: safe to call for devices that already have credentials.
   */
  private async ensureCredentials(device: Device): Promise<boolean> {
    const existing = await this.credentialsRepository.findOne({
      where: { deviceId: device.id },
    });

    if (existing) return false;

    await this.credentialsRepository.save(
      this.credentialsRepository.create({
        deviceId: device.id,
        credentialsType: CredentialsType.ACCESS_TOKEN,
        credentialsId: `${device.deviceKey}_${DeviceCredentials.generateToken()}`,
        // ACCESS_TOKEN is self-contained in credentialsId — no separate secret.
        credentialsValue: undefined,
        isActive: true,
      }),
    );

    return true;
  }

  async seed(): Promise<void> {
    const users = await this.userRepository.find({ take: 5 });
    const tenants = await this.tenantRepository.find({ take: 2 });

    if (!users.length || !tenants.length) {
      console.log('⚠️ Seed Users and Tenants first.');
      return;
    }

    const now = new Date();

    const devices = [
      // 1️⃣ Temperature Sensor
      {
        deviceKey: randomUUID(),
        name: 'Temperature Sensor A1',
        description: 'Room temperature monitoring sensor',
        type: DeviceType.SENSOR,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[0].id,
        userId: users[0].id,
        firmwareVersion: '1.0.0',
        hardwareVersion: 'HW-1',
        ipAddress: '192.168.0.10',
        macAddress: '00:1A:2B:3C:4D:01',
        latitude: 24.7136,
        longitude: 46.6753,
        location: 'Building A - Room 101',
        configuration: {
          reportingInterval: 60,
          temperatureUnit: 'celsius',
        },
        metadata: {
          manufacturer: 'DemoTech',
          model: 'DT-Temp-100',
        },
        tags: ['temperature', 'indoor'],
        lastSeenAt: now,
        lastActivityAt: now,
        activatedAt: now,
        messageCount: 1500,
        errorCount: 2,
      },

      // 2️⃣ Gateway
      {
        deviceKey: randomUUID(),
        name: 'Main Gateway G1',
        description: 'Primary network gateway',
        type: DeviceType.GATEWAY,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0].id,
        userId: users[1]?.id || users[0].id,
        ipAddress: '192.168.0.1',
        macAddress: '00:1A:2B:3C:4D:02',
        location: 'Server Room',
        configuration: {
          protocol: 'MQTT',
          maxConnectedDevices: 100,
        },
        metadata: {
          manufacturer: 'GatewayCorp',
          model: 'GW-500',
        },
        tags: ['gateway', 'core-network'],
        lastSeenAt: now,
        lastActivityAt: now,
        activatedAt: now,
        messageCount: 10000,
        errorCount: 1,
      },

      // 3️⃣ HVAC Controller
      {
        deviceKey: randomUUID(),
        name: 'HVAC Controller C1',
        description: 'Controls air conditioning',
        type: DeviceType.CONTROLLER,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[1]?.id || tenants[0].id,
        userId: users[2]?.id || users[0].id,
        ipAddress: '192.168.0.20',
        macAddress: '00:1A:2B:3C:4D:03',
        location: 'Floor 2 HVAC Room',
        configuration: {
          targetTemperature: 22,
          mode: 'auto',
        },
        metadata: {
          manufacturer: 'ClimateX',
          model: 'HVAC-Pro',
        },
        tags: ['hvac', 'automation'],
        lastSeenAt: now,
        lastActivityAt: now,
        activatedAt: now,
        messageCount: 3200,
        errorCount: 0,
      },

      // 4️⃣ Security Camera
      {
        deviceKey: randomUUID(),
        name: 'Entrance Camera CAM1',
        description: 'Monitors main entrance',
        type: DeviceType.CAMERA,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0].id,
        userId: users[0].id,
        ipAddress: '192.168.0.30',
        macAddress: '00:1A:2B:3C:4D:04',
        location: 'Main Entrance',
        configuration: {
          resolution: '1080p',
          motionDetection: true,
        },
        metadata: {
          manufacturer: 'SecureVision',
          model: 'SV-CAM-200',
        },
        tags: ['camera', 'security'],
        lastSeenAt: now,
        lastActivityAt: now,
        activatedAt: now,
        messageCount: 50000,
        errorCount: 5,
      },

      // 5️⃣ Offline Sensor
      {
        deviceKey: randomUUID(),
        name: 'Pressure Sensor P1',
        description: 'Pressure monitoring sensor',
        type: DeviceType.SENSOR,
        status: DeviceStatus.OFFLINE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[1]?.id || tenants[0].id,
        userId: users[3]?.id || users[0].id,
        location: 'Plant Room',
        configuration: {
          unit: 'psi',
          maxPressure: 150,
        },
        metadata: {
          manufacturer: 'PressureTech',
          model: 'PT-500',
        },
        tags: ['pressure', 'critical'],
        lastSeenAt: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
        lastActivityAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
        activatedAt: now,
        messageCount: 850,
        errorCount: 12,
      },
    ];

    let credentialsCreated = 0;

    for (const data of devices) {
      const exists = await this.deviceRepository.findOne({
        where: { deviceKey: data.deviceKey },
      });

      // Every device leaves this loop with credentials — whether it was
      // created just now or already existed from an earlier run.
      const device =
        exists ??
        ((await this.deviceRepository.save(
          this.deviceRepository.create(data as any),
        )) as unknown as Device);

      if (!exists) {
        console.log(`✅ Created: ${data.name}`);
      }

      if (await this.ensureCredentials(device)) {
        credentialsCreated++;
        console.log(`   🔑 Credentials created for: ${data.name}`);
      }
    }

    console.log(
      `🎉 Device seeding completed (5 records only). ` +
        `Credentials created: ${credentialsCreated}.`,
    );
  }
}