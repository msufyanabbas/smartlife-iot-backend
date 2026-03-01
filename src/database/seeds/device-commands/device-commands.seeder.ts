// src/database/seeders/device-commands.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceCommand, User, Device, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class DeviceCommandsSeeder implements ISeeder {
  constructor(
    @InjectRepository(DeviceCommand)
    private readonly commandRepository: Repository<DeviceCommand>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    console.log('⚙️  Seeding device commands...');

    // 1️⃣ Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // 2️⃣ Get first user from tenant
    const user = await this.userRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    if (!user) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // 3️⃣ Get devices from tenant
    const devices = await this.deviceRepository.find({
      where: { tenantId: tenant.id },
      take: 5,
    });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    const now = new Date();

    const commandsData: Partial<DeviceCommand>[] = [
      {
        tenantId: tenant.id,
        deviceId: devices[0]?.id,
        userId: user.id,
        commandType: 'turnOn',
        priority: 'NORMAL',
        status: 'COMPLETED',
        deliveredAt: now,
        completedAt: now,
        statusMessage: 'Command executed successfully',
        timeout: 30000,
        retries: 3,
        params: {},
        metadata: { seeded: true },
      },
      {
        tenantId: tenant.id,
        deviceId: devices[1]?.id || devices[0]?.id,
        userId: user.id,
        commandType: 'setTemperature',
        priority: 'HIGH',
        status: 'FAILED',
        statusMessage: 'Device timeout',
        timeout: 30000,
        retries: 1,
        params: { value: 24 },
        metadata: { seeded: true },
      },
      {
        tenantId: tenant.id,
        deviceId: devices[2]?.id || devices[0]?.id,
        userId: user.id,
        commandType: 'restart',
        priority: 'URGENT',
        status: 'PENDING',
        statusMessage: 'Waiting to be sent',
        timeout: 30000,
        retries: 3,
        params: {},
        metadata: { seeded: true },
      },
      {
        tenantId: tenant.id,
        deviceId: devices[3]?.id || devices[0]?.id,
        userId: user.id,
        commandType: 'updateFirmware',
        priority: 'NORMAL',
        status: 'SCHEDULED',
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
        statusMessage: 'Scheduled execution',
        timeout: 60000,
        retries: 3,
        params: { version: '2.0.0' },
        metadata: { seeded: true },
      },
      {
        tenantId: tenant.id,
        deviceId: devices[4]?.id || devices[0]?.id,
        userId: user.id,
        commandType: 'captureSnapshot',
        priority: 'LOW',
        status: 'QUEUED',
        statusMessage: 'Device offline',
        timeout: 30000,
        retries: 3,
        params: {},
        metadata: { seeded: true },
      },
    ];

    for (const commandData of commandsData) {
      const existing = await this.commandRepository.findOne({
        where: {
          commandType: commandData.commandType,
          deviceId: commandData.deviceId,
          tenantId: commandData.tenantId,
        },
      });

      if (!existing) {
        const command = this.commandRepository.create(commandData);
        await this.commandRepository.save(command);
        console.log(
          `✅ Created device command: ${commandData.commandType}`,
        );
      } else {
        console.log(
          `⏭️  Device command already exists: ${commandData.commandType}`,
        );
      }
    }

    console.log('🎉 Device commands seeding completed! (5 commands created)');
  }
}