import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EdgeStatus } from '@modules/edge/entities/edge-instance.entity';
import { EdgeInstance, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class EdgeInstanceSeeder implements ISeeder {
  constructor(
    @InjectRepository(EdgeInstance)
    private readonly edgeInstanceRepository: Repository<EdgeInstance>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all users first
    const users = await this.userRepository.find({ take: 10 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper function to generate random IP address
    const generateRandomIP = (): string => {
      return `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    };

    // Helper function to generate uptime string
    const generateUptime = (): string => {
      const days = Math.floor(Math.random() * 30);
      const hours = Math.floor(Math.random() * 24);
      const minutes = Math.floor(Math.random() * 60);
      return `${days}d ${hours}h ${minutes}m`;
    };

    // Helper function to generate last seen date
    const generateLastSeen = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(date.getHours() - Math.floor(Math.random() * 24));
      return date;
    };

    const edgeInstances = [
      {
        name: 'Edge Gateway - Headquarters',
        location: 'Riyadh Main Office, Building A',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.1.100',
        lastSeen: new Date(),
        devices: 24,
        metrics: {
          cpu: 45.2,
          memory: 62.8,
          storage: 58.5,
          uptime: '15d 8h 32m',
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Edge Server - Manufacturing Floor',
        location: 'Industrial Zone, Factory 1',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.2.50',
        lastSeen: generateLastSeen(0),
        devices: 48,
        metrics: {
          cpu: 68.5,
          memory: 75.3,
          storage: 82.1,
          uptime: '22d 14h 15m',
        },
        dataSync: {
          pending: 5,
          lastSync: generateLastSeen(0),
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Edge Node - Warehouse A',
        location: 'Dammam Logistics Center, Warehouse A',
        status: EdgeStatus.SYNCING,
        version: '2.4.8',
        ipAddress: '192.168.3.25',
        lastSeen: generateLastSeen(0),
        devices: 16,
        metrics: {
          cpu: 35.8,
          memory: 48.2,
          storage: 45.9,
          uptime: '8d 4h 22m',
        },
        dataSync: {
          pending: 142,
          lastSync: generateLastSeen(0),
        },
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Edge Gateway - Jeddah Branch',
        location: 'Jeddah Office, Tower B, Floor 12',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.4.10',
        lastSeen: generateLastSeen(0),
        devices: 31,
        metrics: {
          cpu: 52.3,
          memory: 58.7,
          storage: 64.2,
          uptime: '18d 21h 45m',
        },
        dataSync: {
          pending: 2,
          lastSync: new Date(),
        },
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Edge Server - Data Center 1',
        location: 'Riyadh Data Center, Rack 7A',
        status: EdgeStatus.ONLINE,
        version: '2.5.4-beta',
        ipAddress: '192.168.5.200',
        lastSeen: new Date(),
        devices: 72,
        metrics: {
          cpu: 78.9,
          memory: 82.4,
          storage: 88.7,
          uptime: '45d 12h 8m',
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
        },
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Edge Node - Remote Site Alpha',
        location: 'Al Khobar Remote Station',
        status: EdgeStatus.OFFLINE,
        version: '2.4.5',
        ipAddress: '192.168.6.45',
        lastSeen: generateLastSeen(2),
        devices: 8,
        metrics: {
          cpu: 0,
          memory: 0,
          storage: 0,
          uptime: '0d 0h 0m',
        },
        dataSync: {
          pending: 385,
          lastSync: generateLastSeen(2),
        },
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Edge Gateway - Smart City Hub',
        location: 'NEOM Smart City, Central Hub',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.7.100',
        lastSeen: generateLastSeen(0),
        devices: 156,
        metrics: {
          cpu: 65.4,
          memory: 71.2,
          storage: 75.8,
          uptime: '32d 18h 42m',
        },
        dataSync: {
          pending: 12,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Server - Hospital Network',
        location: 'King Fahad Medical City, IT Wing',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.8.50',
        lastSeen: new Date(),
        devices: 64,
        metrics: {
          cpu: 58.7,
          memory: 68.9,
          storage: 71.3,
          uptime: '28d 6h 15m',
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Node - Retail Store Central',
        location: 'Riyadh Mall, Central Management',
        status: EdgeStatus.ERROR,
        version: '2.5.1',
        ipAddress: '192.168.9.75',
        lastSeen: generateLastSeen(0),
        devices: 28,
        metrics: {
          cpu: 92.5,
          memory: 95.8,
          storage: 98.2,
          uptime: '5d 2h 38m',
        },
        dataSync: {
          pending: 523,
          lastSync: generateLastSeen(1),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Gateway - Airport Terminal',
        location: 'King Khalid International Airport, Terminal 5',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.10.20',
        lastSeen: generateLastSeen(0),
        devices: 89,
        metrics: {
          cpu: 54.2,
          memory: 62.5,
          storage: 68.9,
          uptime: '41d 15h 22m',
        },
        dataSync: {
          pending: 8,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Server - Research Lab',
        location: 'KAUST Research Center, Lab Building 3',
        status: EdgeStatus.ONLINE,
        version: '2.5.4-beta',
        ipAddress: '192.168.11.150',
        lastSeen: new Date(),
        devices: 42,
        metrics: {
          cpu: 72.8,
          memory: 78.4,
          storage: 55.6,
          uptime: '12d 9h 48m',
        },
        dataSync: {
          pending: 3,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Node - Construction Site',
        location: 'Red Sea Project, Site Office 12',
        status: EdgeStatus.SYNCING,
        version: '2.4.8',
        ipAddress: generateRandomIP(),
        lastSeen: generateLastSeen(0),
        devices: 12,
        metrics: {
          cpu: 42.1,
          memory: 55.3,
          storage: 38.7,
          uptime: '3d 18h 12m',
        },
        dataSync: {
          pending: 234,
          lastSync: generateLastSeen(0),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Gateway - Energy Plant',
        location: 'Yanbu Industrial Complex, Power Station',
        status: EdgeStatus.ONLINE,
        version: '2.5.2',
        ipAddress: generateRandomIP(),
        lastSeen: generateLastSeen(0),
        devices: 96,
        metrics: {
          cpu: 68.3,
          memory: 74.6,
          storage: 81.2,
          uptime: '58d 22h 35m',
        },
        dataSync: {
          pending: 1,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Server - University Campus',
        location: 'King Saud University, Engineering Building',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: generateRandomIP(),
        lastSeen: new Date(),
        devices: 54,
        metrics: {
          cpu: 48.9,
          memory: 58.2,
          storage: 62.4,
          uptime: generateUptime(),
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Edge Node - Telecommunications Hub',
        location: 'Medina Telecom Center',
        status: EdgeStatus.OFFLINE,
        version: '2.4.2',
        ipAddress: generateRandomIP(),
        lastSeen: generateLastSeen(5),
        devices: 18,
        metrics: {
          cpu: 0,
          memory: 0,
          storage: 0,
          uptime: '0d 0h 0m',
        },
        dataSync: {
          pending: 892,
          lastSync: generateLastSeen(5),
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const edgeData of edgeInstances) {
      const existing = await this.edgeInstanceRepository.findOne({
        where: { name: edgeData.name, userId: edgeData.userId },
      });

      if (!existing) {
        const edgeInstance = this.edgeInstanceRepository.create(edgeData);
        await this.edgeInstanceRepository.save(edgeInstance);
        console.log(
          `✅ Created edge instance: ${edgeData.name} (${edgeData.status})`,
        );
      } else {
        console.log(`⏭️  Edge instance already exists: ${edgeData.name}`);
      }
    }

    console.log('🎉 Edge instance seeding completed!');
  }
}
