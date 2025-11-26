import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {} from '@modules/index.entities';
import {
  Device,
  DeviceType,
  DeviceStatus,
  DeviceConnectionType,
} from '@modules/devices/entities/device.entity';
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
  ) {}

  async seed(): Promise<void> {
    // Fetch users and tenants for referential integrity
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (tenants.length === 0) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
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

    const getDateMinutesAgo = (minutes: number): Date => {
      const date = new Date();
      date.setMinutes(date.getMinutes() - minutes);
      return date;
    };

    const devices = [
      // Temperature & Humidity Sensors
      {
        deviceKey: randomUUID(),
        name: 'Temperature Sensor 01',
        description: 'High-precision temperature and humidity sensor',
        type: DeviceType.SENSOR,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '1.2.3',
        hardwareVersion: 'v2.1',
        ipAddress: '192.168.1.101',
        macAddress: '00:1B:44:11:3A:B7',
        latitude: 24.7136,
        longitude: 46.6753,
        location: 'Building A - Floor 1 - Room 101',
        metadata: {
          model: 'TH-100',
          manufacturer: 'Acme IoT',
          serialNumber: 'TH100-2024-001',
          installationDate: '2024-01-15',
        },
        configuration: {
          sampleRate: 60,
          unit: 'celsius',
          alertThreshold: { min: 18, max: 28 },
        },
        lastSeenAt: getDateMinutesAgo(2),
        lastActivityAt: getDateMinutesAgo(2),
        activatedAt: getDateDaysAgo(90),
        messageCount: 129600,
        errorCount: 12,
        tags: ['temperature', 'humidity', 'production', 'floor-1'],
      },
      {
        deviceKey: randomUUID(),
        name: 'Temperature Sensor 02',
        description: 'Industrial temperature sensor for production line',
        type: DeviceType.SENSOR,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0]?.id,
        userId: users[1]?.id || users[0]?.id,
        user: users[1] || users[0],
        firmwareVersion: '1.2.5',
        hardwareVersion: 'v2.2',
        ipAddress: '192.168.1.102',
        macAddress: '00:1B:44:11:3A:B8',
        latitude: 24.7138,
        longitude: 46.6755,
        location: 'Building B - Production Line 1',
        metadata: {
          model: 'TH-100',
          manufacturer: 'Acme IoT',
          serialNumber: 'TH100-2024-002',
          installationDate: '2024-02-20',
        },
        configuration: {
          sampleRate: 30,
          unit: 'celsius',
          alertThreshold: { min: 15, max: 35 },
        },
        lastSeenAt: getDateMinutesAgo(1),
        lastActivityAt: getDateMinutesAgo(1),
        activatedAt: getDateDaysAgo(60),
        messageCount: 172800,
        errorCount: 5,
        tags: ['temperature', 'production', 'line-1'],
      },
      // Pressure Sensors
      {
        deviceKey: randomUUID(),
        name: 'Pressure Sensor 01',
        description: 'High-accuracy pressure sensor for hydraulic systems',
        type: DeviceType.SENSOR,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '2.1.0',
        hardwareVersion: 'v1.5',
        ipAddress: '192.168.1.103',
        macAddress: '00:1B:44:11:3A:B9',
        latitude: 24.714,
        longitude: 46.6757,
        location: 'Building B - Hydraulic Station',
        metadata: {
          model: 'PS-200',
          manufacturer: 'Industrial Sensors Inc',
          serialNumber: 'PS200-2024-001',
          installationDate: '2024-03-10',
        },
        configuration: {
          sampleRate: 10,
          unit: 'psi',
          maxPressure: 150,
          alertThreshold: { min: 50, max: 120 },
        },
        lastSeenAt: getDateMinutesAgo(3),
        lastActivityAt: getDateMinutesAgo(3),
        activatedAt: getDateDaysAgo(45),
        messageCount: 388800,
        errorCount: 8,
        tags: ['pressure', 'hydraulic', 'critical'],
      },
      // Gateways
      {
        deviceKey: randomUUID(),
        name: 'Smart Gateway 01',
        description: 'Edge gateway for sensor network aggregation',
        type: DeviceType.GATEWAY,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '3.0.1',
        hardwareVersion: 'v3.0',
        ipAddress: '192.168.1.10',
        macAddress: '00:1B:44:11:3A:AA',
        latitude: 24.7136,
        longitude: 46.6753,
        location: 'Building A - Server Room',
        metadata: {
          model: 'GW-500',
          manufacturer: 'Acme IoT',
          serialNumber: 'GW500-2024-001',
          installationDate: '2024-01-05',
          connectedDevices: 15,
        },
        configuration: {
          maxConnections: 50,
          protocol: 'MQTT',
          dataForwarding: true,
        },
        lastSeenAt: getDateMinutesAgo(1),
        lastActivityAt: getDateMinutesAgo(1),
        activatedAt: getDateDaysAgo(120),
        messageCount: 518400,
        errorCount: 3,
        tags: ['gateway', 'edge', 'server-room'],
      },
      {
        deviceKey: randomUUID(),
        name: 'Smart Gateway 02',
        description: 'Backup gateway for redundancy',
        type: DeviceType.GATEWAY,
        status: DeviceStatus.INACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[1]?.id || tenants[0]?.id,
        userId: users[2]?.id || users[0]?.id,
        user: users[2] || users[0],
        firmwareVersion: '3.0.0',
        hardwareVersion: 'v3.0',
        ipAddress: '192.168.1.11',
        macAddress: '00:1B:44:11:3A:AB',
        location: 'Building C - Backup Room',
        metadata: {
          model: 'GW-500',
          manufacturer: 'Acme IoT',
          serialNumber: 'GW500-2024-002',
          installationDate: '2024-04-01',
        },
        configuration: {
          maxConnections: 50,
          protocol: 'MQTT',
          dataForwarding: true,
          standbyMode: true,
        },
        lastSeenAt: getDateDaysAgo(5),
        lastActivityAt: getDateDaysAgo(5),
        activatedAt: getDateDaysAgo(30),
        messageCount: 5200,
        errorCount: 0,
        tags: ['gateway', 'backup', 'standby'],
      },
      // Controllers
      {
        deviceKey: randomUUID(),
        name: 'HVAC Controller 01',
        description: 'Smart HVAC system controller',
        type: DeviceType.CONTROLLER,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[0]?.id,
        userId: users[1]?.id || users[0]?.id,
        user: users[1] || users[0],
        firmwareVersion: '4.2.1',
        hardwareVersion: 'v2.0',
        ipAddress: '192.168.1.150',
        macAddress: '00:1B:44:11:3A:C1',
        latitude: 24.7136,
        longitude: 46.6753,
        location: 'Building A - HVAC Room',
        metadata: {
          model: 'HC-300',
          manufacturer: 'Climate Control Systems',
          serialNumber: 'HC300-2024-001',
          installationDate: '2024-02-15',
          zones: 4,
        },
        configuration: {
          mode: 'auto',
          targetTemperature: 22,
          operatingHours: { start: '06:00', end: '20:00' },
        },
        lastSeenAt: getDateMinutesAgo(5),
        lastActivityAt: getDateMinutesAgo(5),
        activatedAt: getDateDaysAgo(75),
        messageCount: 108000,
        errorCount: 15,
        tags: ['controller', 'hvac', 'automation'],
      },
      {
        deviceKey: randomUUID(),
        name: 'Lighting Controller 01',
        description: 'Smart lighting system controller',
        type: DeviceType.CONTROLLER,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ZIGBEE,
        tenantId: tenants[1]?.id || tenants[0]?.id,
        userId: users[2]?.id || users[0]?.id,
        user: users[2] || users[0],
        firmwareVersion: '2.5.0',
        hardwareVersion: 'v1.8',
        ipAddress: '192.168.1.151',
        macAddress: '00:1B:44:11:3A:C2',
        location: 'Building D - Control Panel',
        metadata: {
          model: 'LC-200',
          manufacturer: 'Smart Lighting Inc',
          serialNumber: 'LC200-2024-001',
          installationDate: '2024-05-10',
          lights: 32,
        },
        configuration: {
          schedule: 'auto',
          brightness: 80,
          motionDetection: true,
        },
        lastSeenAt: getDateMinutesAgo(4),
        lastActivityAt: getDateMinutesAgo(4),
        activatedAt: getDateDaysAgo(20),
        messageCount: 28800,
        errorCount: 2,
        tags: ['controller', 'lighting', 'energy-saving'],
      },
      // Actuators
      {
        deviceKey: randomUUID(),
        name: 'Valve Actuator 01',
        description: 'Motorized valve actuator for water control',
        type: DeviceType.ACTUATOR,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '1.8.2',
        hardwareVersion: 'v1.3',
        ipAddress: '192.168.1.201',
        macAddress: '00:1B:44:11:3A:D1',
        latitude: 24.7142,
        longitude: 46.6759,
        location: 'Building B - Water Distribution',
        metadata: {
          model: 'VA-150',
          manufacturer: 'FlowControl Systems',
          serialNumber: 'VA150-2024-001',
          installationDate: '2024-03-20',
          valveSize: '2-inch',
        },
        configuration: {
          operationMode: 'proportional',
          responseTime: 5,
          positionFeedback: true,
        },
        lastSeenAt: getDateMinutesAgo(10),
        lastActivityAt: getDateMinutesAgo(10),
        activatedAt: getDateDaysAgo(50),
        messageCount: 72000,
        errorCount: 6,
        tags: ['actuator', 'valve', 'water-control'],
      },
      // Cameras
      {
        deviceKey: randomUUID(),
        name: 'Security Camera 01',
        description: 'IP camera for entrance monitoring',
        type: DeviceType.CAMERA,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '5.1.2',
        hardwareVersion: 'v4.0',
        ipAddress: '192.168.1.50',
        macAddress: '00:1B:44:11:3A:E1',
        latitude: 24.7136,
        longitude: 46.6753,
        location: 'Building A - Main Entrance',
        metadata: {
          model: 'CAM-4K',
          manufacturer: 'SecureVision',
          serialNumber: 'CAM4K-2024-001',
          installationDate: '2024-01-10',
          resolution: '4K',
          nightVision: true,
        },
        configuration: {
          recording: true,
          motionDetection: true,
          fps: 30,
          quality: 'high',
        },
        lastSeenAt: getDateMinutesAgo(1),
        lastActivityAt: getDateMinutesAgo(1),
        activatedAt: getDateDaysAgo(100),
        messageCount: 8640000,
        errorCount: 25,
        tags: ['camera', 'security', 'entrance'],
      },
      // Trackers
      {
        deviceKey: randomUUID(),
        name: 'Asset Tracker 01',
        description: 'GPS tracker for fleet management',
        type: DeviceType.TRACKER,
        status: DeviceStatus.ACTIVE,
        connectionType: DeviceConnectionType.CELLULAR,
        tenantId: tenants[1]?.id || tenants[0]?.id,
        userId: users[3]?.id || users[0]?.id,
        user: users[3] || users[0],
        firmwareVersion: '2.3.1',
        hardwareVersion: 'v1.5',
        ipAddress: '10.20.30.40',
        latitude: 24.75,
        longitude: 46.7,
        location: 'Vehicle - Truck 001',
        metadata: {
          model: 'GT-100',
          manufacturer: 'TrackTech',
          serialNumber: 'GT100-2024-001',
          installationDate: '2024-04-05',
          vehicleId: 'TRK-001',
        },
        configuration: {
          reportInterval: 300,
          geofencing: true,
          speedLimit: 120,
        },
        lastSeenAt: getDateMinutesAgo(6),
        lastActivityAt: getDateMinutesAgo(6),
        activatedAt: getDateDaysAgo(35),
        messageCount: 10080,
        errorCount: 4,
        tags: ['tracker', 'gps', 'fleet', 'vehicle'],
      },
      // Offline/Error Devices
      {
        deviceKey: randomUUID(),
        name: 'Temperature Sensor 03',
        description: 'Malfunctioning temperature sensor',
        type: DeviceType.SENSOR,
        status: DeviceStatus.ERROR,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[0]?.id,
        userId: users[0]?.id,
        user: users[0],
        firmwareVersion: '1.1.8',
        hardwareVersion: 'v2.0',
        ipAddress: '192.168.1.104',
        macAddress: '00:1B:44:11:3A:BA',
        location: 'Building C - Storage Room',
        metadata: {
          model: 'TH-100',
          manufacturer: 'Acme IoT',
          serialNumber: 'TH100-2023-050',
          installationDate: '2023-11-15',
          issueReported: '2025-11-03',
        },
        configuration: {
          sampleRate: 60,
          unit: 'celsius',
        },
        lastSeenAt: getDateDaysAgo(2),
        lastActivityAt: getDateDaysAgo(2),
        activatedAt: getDateDaysAgo(180),
        messageCount: 259200,
        errorCount: 145,
        tags: ['temperature', 'error', 'maintenance-required'],
      },
      {
        deviceKey: randomUUID(),
        name: 'Gateway 03 - Offline',
        description: 'Offline gateway requiring maintenance',
        type: DeviceType.GATEWAY,
        status: DeviceStatus.OFFLINE,
        connectionType: DeviceConnectionType.ETHERNET,
        tenantId: tenants[1]?.id || tenants[0]?.id,
        userId: users[1]?.id || users[0]?.id,
        user: users[1] || users[0],
        firmwareVersion: '2.8.5',
        hardwareVersion: 'v2.5',
        ipAddress: '192.168.1.12',
        macAddress: '00:1B:44:11:3A:AC',
        location: 'Building E - Remote Site',
        metadata: {
          model: 'GW-400',
          manufacturer: 'Acme IoT',
          serialNumber: 'GW400-2023-010',
          installationDate: '2023-10-01',
        },
        configuration: {
          maxConnections: 30,
          protocol: 'MQTT',
        },
        lastSeenAt: getDateDaysAgo(7),
        lastActivityAt: getDateDaysAgo(7),
        activatedAt: getDateDaysAgo(200),
        messageCount: 864000,
        errorCount: 50,
        tags: ['gateway', 'offline', 'maintenance'],
      },
      {
        deviceKey: randomUUID(),
        name: 'Controller 03 - Maintenance',
        description: 'Controller under scheduled maintenance',
        type: DeviceType.CONTROLLER,
        status: DeviceStatus.MAINTENANCE,
        connectionType: DeviceConnectionType.WIFI,
        tenantId: tenants[0]?.id,
        userId: users[2]?.id || users[0]?.id,
        user: users[2] || users[0],
        firmwareVersion: '3.5.0',
        hardwareVersion: 'v1.9',
        ipAddress: '192.168.1.152',
        macAddress: '00:1B:44:11:3A:C3',
        location: 'Building F - Maintenance Bay',
        metadata: {
          model: 'MC-250',
          manufacturer: 'Control Systems Ltd',
          serialNumber: 'MC250-2024-005',
          installationDate: '2024-06-01',
          maintenanceScheduled: '2025-11-05',
        },
        configuration: {
          mode: 'standby',
        },
        lastSeenAt: getDateDaysAgo(1),
        lastActivityAt: getDateDaysAgo(1),
        activatedAt: getDateDaysAgo(15),
        messageCount: 21600,
        errorCount: 0,
        tags: ['controller', 'maintenance', 'scheduled'],
      },
    ];

    for (const deviceData of devices) {
      const existing = await this.deviceRepository.findOne({
        where: { deviceKey: deviceData.deviceKey },
      });

      if (!existing) {
        const device = this.deviceRepository.create(deviceData as any);
        await this.deviceRepository.save(device);
        console.log(
          `✅ Created device: ${deviceData.name} (${deviceData.type})`,
        );
      } else {
        console.log(`⏭️  Device already exists: ${deviceData.name}`);
      }
    }

    console.log('🎉 Device seeding completed!');
  }
}
