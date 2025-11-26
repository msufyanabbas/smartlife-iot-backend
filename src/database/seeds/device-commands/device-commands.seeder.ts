import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { User } from '@modules/users/entities/user.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class DeviceCommandsSeeder implements ISeeder {
  constructor(
    @InjectRepository(DeviceCommand)
    private readonly commandRepository: Repository<DeviceCommand>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    console.log('🎯 Starting Device Commands Seeder...');

    // Fetch devices and users for referential integrity
    const devices = await this.deviceRepository.find({ take: 20 });
    const users = await this.userRepository.find({ take: 5 });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const getDateDaysAgo = (days: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - days);
      return date;
    };

    const getRandomDateInPast = (maxDaysAgo: number): Date => {
      const daysAgo = Math.floor(Math.random() * maxDaysAgo);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(Math.floor(Math.random() * 24));
      date.setMinutes(Math.floor(Math.random() * 60));
      date.setSeconds(Math.floor(Math.random() * 60));
      return date;
    };

    // Define command types based on device types
    const commandsByDeviceType: Record<
      string,
      Array<{ type: string; params: Record<string, any> }>
    > = {
      SENSOR: [
        { type: 'calibrate', params: {} },
        { type: 'setInterval', params: { interval: 60 } },
        { type: 'reset', params: {} },
        { type: 'updateThreshold', params: { min: 20, max: 30 } },
        { type: 'enableAlert', params: { enabled: true } },
      ],
      ACTUATOR: [
        { type: 'turnOn', params: {} },
        { type: 'turnOff', params: {} },
        { type: 'toggle', params: {} },
        { type: 'setValue', params: { value: 50 } },
        { type: 'setPosition', params: { position: 75 } },
      ],
      CONTROLLER: [
        { type: 'start', params: {} },
        { type: 'stop', params: {} },
        { type: 'restart', params: {} },
        { type: 'configure', params: { setting: 'auto' } },
        { type: 'setMode', params: { mode: 'manual' } },
      ],
      GATEWAY: [
        { type: 'reboot', params: {} },
        { type: 'updateFirmware', params: { version: '2.1.0' } },
        { type: 'scanDevices', params: {} },
        { type: 'syncTime', params: {} },
      ],
      CAMERA: [
        { type: 'captureSnapshot', params: {} },
        { type: 'startRecording', params: { duration: 300 } },
        { type: 'stopRecording', params: {} },
        { type: 'panTilt', params: { pan: 45, tilt: 30 } },
        { type: 'setResolution', params: { resolution: '1080p' } },
      ],
      TRACKER: [
        { type: 'getLocation', params: {} },
        { type: 'setGeofence', params: { radius: 1000 } },
        { type: 'enableTracking', params: { interval: 60 } },
        { type: 'updateInterval', params: { interval: 300 } },
      ],
    };

    // Status options with weights (more likely to be completed/delivered)
    const statusOptions = [
      { status: 'COMPLETED', weight: 40 },
      { status: 'DELIVERED', weight: 30 },
      { status: 'PENDING', weight: 10 },
      { status: 'FAILED', weight: 10 },
      { status: 'QUEUED', weight: 5 },
      { status: 'CANCELLED', weight: 5 },
    ];

    const getWeightedRandomStatus = (): string => {
      const randomWeight = Math.random() * 100;
      let cumulativeWeight = 0;

      for (const option of statusOptions) {
        cumulativeWeight += option.weight;
        if (randomWeight <= cumulativeWeight) {
          return option.status;
        }
      }
      return 'PENDING';
    };

    // Priority options with weights
    const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
    const priorityWeights = [20, 50, 25, 5];

    const getWeightedRandomPriority = (): string => {
      const randomPriority = Math.random() * 100;
      let cumulativeWeight = 0;

      for (let i = 0; i < priorities.length; i++) {
        cumulativeWeight += priorityWeights[i];
        if (randomPriority <= cumulativeWeight) {
          return priorities[i];
        }
      }
      return 'NORMAL';
    };

    const stats = {
      total: 0,
      byStatus: {} as Record<string, number>,
      byPriority: {} as Record<string, number>,
      byDeviceType: {} as Record<string, number>,
    };

    // Create commands for each device
    for (const device of devices) {
      // Get appropriate commands for this device type
      const deviceCommands =
        commandsByDeviceType[device.type] || commandsByDeviceType.SENSOR;

      // Create 3-8 commands per device with varying ages
      const commandCount = Math.floor(Math.random() * 6) + 3;

      for (let i = 0; i < commandCount; i++) {
        // Random command from device type
        const commandTemplate = getRandomItem(deviceCommands);

        // Random user
        const user = getRandomItem(users);

        // Get random status and priority
        const selectedStatus = getWeightedRandomStatus();
        const selectedPriority = getWeightedRandomPriority();

        // Random timestamp in the past (last 30 days)
        const createdAt = getRandomDateInPast(30);

        // Delivered timestamp (if delivered/completed)
        let deliveredAt: Date | undefined = undefined;
        let completedAt: Date | undefined = undefined;
        let statusMessage: string | undefined = undefined;

        if (['DELIVERED', 'COMPLETED'].includes(selectedStatus)) {
          deliveredAt = new Date(createdAt);
          deliveredAt.setSeconds(
            deliveredAt.getSeconds() + Math.floor(Math.random() * 30) + 5,
          );
        }

        if (selectedStatus === 'COMPLETED') {
          completedAt = new Date(deliveredAt!);
          completedAt.setSeconds(
            completedAt.getSeconds() + Math.floor(Math.random() * 10) + 1,
          );
          statusMessage = 'Command executed successfully';
        }

        if (selectedStatus === 'FAILED') {
          statusMessage = 'Device did not respond within timeout period';
        }

        if (selectedStatus === 'QUEUED') {
          statusMessage = 'Device offline - command queued for delivery';
        }

        if (selectedStatus === 'CANCELLED') {
          statusMessage = 'Cancelled by user request';
        }

        if (selectedStatus === 'PENDING') {
          statusMessage = 'Waiting to be sent to device';
        }

        // Build command data object
        const commandData: any = {
          deviceId: device.id,
          userId: user.id,
          tenantId: device.tenantId,
          commandType: commandTemplate.type,
          params: commandTemplate.params,
          priority: selectedPriority,
          status: selectedStatus,
          timeout: 30000,
          retries: selectedStatus === 'FAILED' ? 0 : 3,
          metadata: {
            seeded: true,
            deviceType: device.type,
            deviceName: device.name,
            deviceLocation: device.location,
          },
        };

        // Only add optional fields if they have values
        if (statusMessage !== undefined) {
          commandData.statusMessage = statusMessage;
        }
        if (deliveredAt !== undefined) {
          commandData.deliveredAt = deliveredAt;
        }
        if (completedAt !== undefined) {
          commandData.completedAt = completedAt;
        }

        const command = this.commandRepository.create(commandData);
        await this.commandRepository.save(command);

        // Update statistics
        stats.total++;
        stats.byStatus[selectedStatus] =
          (stats.byStatus[selectedStatus] || 0) + 1;
        stats.byPriority[selectedPriority] =
          (stats.byPriority[selectedPriority] || 0) + 1;
        stats.byDeviceType[device.type] =
          (stats.byDeviceType[device.type] || 0) + 1;

        console.log(
          `✅ Created command: ${commandTemplate.type} for ${device.name} (${selectedStatus})`,
        );
      }
    }

    // Display statistics
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Device Commands Seeded Successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 Total Commands: ${stats.total}`);

    console.log('\n📈 By Status:');
    Object.entries(stats.byStatus)
      .sort(([, a], [, b]) => b - a)
      .forEach(([status, count]) => {
        console.log(`   ${status.padEnd(12)} → ${count}`);
      });

    console.log('\n⚡ By Priority:');
    Object.entries(stats.byPriority)
      .sort(([, a], [, b]) => b - a)
      .forEach(([priority, count]) => {
        console.log(`   ${priority.padEnd(12)} → ${count}`);
      });

    console.log('\n🔧 By Device Type:');
    Object.entries(stats.byDeviceType)
      .sort(([, a], [, b]) => b - a)
      .forEach(([type, count]) => {
        console.log(`   ${type.padEnd(12)} → ${count}`);
      });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('🎉 Device Commands seeding completed!');
  }
}
