// src/database/seeds/edge-instance/edge-instance.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EdgeStatus } from '@common/enums/index.enum';
import { EdgeInstance, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class EdgeInstanceSeeder implements ISeeder {
  private readonly logger = new Logger(EdgeInstanceSeeder.name);

  constructor(
    @InjectRepository(EdgeInstance)
    private readonly edgeInstanceRepository: Repository<EdgeInstance>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting edge instance seeding...');

    // Check if edge instances already exist
    const existingInstances = await this.edgeInstanceRepository.count();
    if (existingInstances > 0) {
      this.logger.log(
        `⏭️  Edge instances already seeded (${existingInstances} records). Skipping...`,
      );
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    this.logger.log(`📊 Found ${users.length} users, ${tenants.length} tenants`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generateRandomIP = (): string => {
      return `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    };

    const generateMacAddress = (): string => {
      return Array.from({ length: 6 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0')
          .toUpperCase(),
      ).join(':');
    };

    const generateUptime = (): number => {
      // Random uptime between 1 day and 60 days in seconds
      return Math.floor(Math.random() * (60 * 86400 - 86400) + 86400);
    };

    const generateLastSeen = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(date.getHours() - Math.floor(Math.random() * 24));
      return date;
    };

    // ════════════════════════════════════════════════════════════════
    // EDGE INSTANCE DATA
    // ════════════════════════════════════════════════════════════════

    const edgeInstances: Partial<EdgeInstance>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. HEADQUARTERS - ONLINE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        name: 'Edge Gateway - Headquarters',
        description: 'Main edge gateway for headquarters building',
        location: 'Riyadh Main Office, Building A',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.1.100',
        macAddress: '00:1B:44:11:3A:B7',
        hostname: 'edge-hq-001',
        lastSeen: new Date(),
        deviceCount: 24,
        metrics: {
          cpu: 45.2,
          memory: 62.8,
          storage: 58.5,
          uptime: generateUptime(),
          temperature: 42,
          networkIn: 1024000,
          networkOut: 512000,
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
          syncInterval: 60,
          failedAttempts: 0,
          totalSynced: 15420,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 50,
          protocols: ['MQTT', 'HTTP', 'Modbus'],
          storageLimit: 100,
          retentionDays: 7,
        },
        tags: ['headquarters', 'production', 'critical'],
      },

      // ════════════════════════════════════════════════════════════════
      // 2. MANUFACTURING FLOOR - ONLINE (HIGH LOAD)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        name: 'Edge Server - Manufacturing Floor',
        description: 'Edge server for factory IoT devices',
        location: 'Industrial Zone, Factory 1',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.2.50',
        macAddress: generateMacAddress(),
        hostname: 'edge-factory-001',
        lastSeen: generateLastSeen(0),
        deviceCount: 48,
        metrics: {
          cpu: 68.5,
          memory: 75.3,
          storage: 82.1,
          uptime: generateUptime(),
          temperature: 55,
          networkIn: 2048000,
          networkOut: 1024000,
        },
        dataSync: {
          pending: 5,
          lastSync: generateLastSeen(0),
          syncInterval: 30,
          failedAttempts: 0,
          totalSynced: 45680,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 100,
          protocols: ['MQTT', 'Modbus', 'OPC-UA'],
          storageLimit: 200,
          retentionDays: 14,
        },
        tags: ['manufacturing', 'industrial', 'high-volume'],
      },

      // ════════════════════════════════════════════════════════════════
      // 3. WAREHOUSE - SYNCING
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        name: 'Edge Node - Warehouse A',
        description: 'Edge node for warehouse logistics',
        location: 'Dammam Logistics Center, Warehouse A',
        status: EdgeStatus.SYNCING,
        version: '2.4.8',
        ipAddress: '192.168.3.25',
        macAddress: generateMacAddress(),
        hostname: 'edge-warehouse-a',
        lastSeen: generateLastSeen(0),
        deviceCount: 16,
        metrics: {
          cpu: 35.8,
          memory: 48.2,
          storage: 45.9,
          uptime: generateUptime(),
          temperature: 38,
        },
        dataSync: {
          pending: 142,
          lastSync: generateLastSeen(0),
          syncInterval: 120,
          failedAttempts: 1,
          totalSynced: 8950,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 30,
          protocols: ['MQTT', 'HTTP'],
          storageLimit: 50,
          retentionDays: 7,
        },
        tags: ['warehouse', 'logistics'],
      },

      // ════════════════════════════════════════════════════════════════
      // 4. DATA CENTER - ONLINE (BETA VERSION)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        name: 'Edge Server - Data Center 1',
        description: 'High-capacity edge server in data center',
        location: 'Riyadh Data Center, Rack 7A',
        status: EdgeStatus.ONLINE,
        version: '2.5.4-beta',
        ipAddress: '192.168.5.200',
        macAddress: generateMacAddress(),
        hostname: 'edge-dc-001',
        lastSeen: new Date(),
        deviceCount: 72,
        metrics: {
          cpu: 78.9,
          memory: 82.4,
          storage: 88.7,
          uptime: 60 * 86400, // 60 days
          temperature: 28,
          networkIn: 5120000,
          networkOut: 2560000,
        },
        dataSync: {
          pending: 0,
          lastSync: new Date(),
          syncInterval: 30,
          failedAttempts: 0,
          totalSynced: 125680,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 150,
          protocols: ['MQTT', 'HTTP', 'Modbus', 'OPC-UA'],
          storageLimit: 500,
          retentionDays: 30,
        },
        tags: ['data-center', 'critical', 'high-capacity'],
      },

      // ════════════════════════════════════════════════════════════════
      // 5. REMOTE SITE - OFFLINE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        name: 'Edge Node - Remote Site Alpha',
        description: 'Remote edge node at field site',
        location: 'Al Khobar Remote Station',
        status: EdgeStatus.OFFLINE,
        version: '2.4.5',
        ipAddress: '192.168.6.45',
        macAddress: generateMacAddress(),
        hostname: 'edge-remote-alpha',
        lastSeen: generateLastSeen(2),
        deviceCount: 8,
        metrics: {
          cpu: 0,
          memory: 0,
          storage: 0,
          uptime: 0,
        },
        dataSync: {
          pending: 385,
          lastSync: generateLastSeen(2),
          syncInterval: 300,
          failedAttempts: 24,
          totalSynced: 2340,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 20,
          protocols: ['MQTT'],
          storageLimit: 25,
          retentionDays: 3,
        },
        tags: ['remote', 'offline', 'needs-attention'],
      },

      // ════════════════════════════════════════════════════════════════
      // 6. SMART CITY - ONLINE (HIGH DEVICE COUNT)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Edge Gateway - Smart City Hub',
        description: 'Central hub for smart city infrastructure',
        location: 'NEOM Smart City, Central Hub',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.7.100',
        macAddress: generateMacAddress(),
        hostname: 'edge-neom-hub',
        lastSeen: generateLastSeen(0),
        deviceCount: 156,
        metrics: {
          cpu: 65.4,
          memory: 71.2,
          storage: 75.8,
          uptime: generateUptime(),
          temperature: 35,
          networkIn: 3072000,
          networkOut: 1536000,
        },
        dataSync: {
          pending: 12,
          lastSync: new Date(),
          syncInterval: 45,
          failedAttempts: 0,
          totalSynced: 89450,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 200,
          protocols: ['MQTT', 'HTTP', 'LoRaWAN'],
          storageLimit: 300,
          retentionDays: 14,
        },
        tags: ['smart-city', 'neom', 'infrastructure'],
      },

      // ════════════════════════════════════════════════════════════════
      // 7. RETAIL - ERROR STATE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Edge Node - Retail Store Central',
        description: 'Edge node for retail store network',
        location: 'Riyadh Mall, Central Management',
        status: EdgeStatus.ERROR,
        version: '2.5.1',
        ipAddress: '192.168.9.75',
        macAddress: generateMacAddress(),
        hostname: 'edge-retail-001',
        lastSeen: generateLastSeen(0),
        deviceCount: 28,
        metrics: {
          cpu: 92.5,
          memory: 95.8,
          storage: 98.2,
          uptime: 5 * 86400, // 5 days
          temperature: 68,
        },
        dataSync: {
          pending: 523,
          lastSync: generateLastSeen(1),
          syncInterval: 60,
          failedAttempts: 12,
          totalSynced: 15680,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 50,
          protocols: ['MQTT', 'HTTP'],
          storageLimit: 30,
          retentionDays: 5,
        },
        tags: ['retail', 'error', 'storage-full'],
      },

      // ════════════════════════════════════════════════════════════════
      // 8. AIRPORT - ONLINE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Edge Gateway - Airport Terminal',
        description: 'Edge gateway for airport IoT systems',
        location: 'King Khalid International Airport, Terminal 5',
        status: EdgeStatus.ONLINE,
        version: '2.5.3',
        ipAddress: '192.168.10.20',
        macAddress: generateMacAddress(),
        hostname: 'edge-airport-t5',
        lastSeen: generateLastSeen(0),
        deviceCount: 89,
        metrics: {
          cpu: 54.2,
          memory: 62.5,
          storage: 68.9,
          uptime: generateUptime(),
          temperature: 32,
        },
        dataSync: {
          pending: 8,
          lastSync: new Date(),
          syncInterval: 45,
          failedAttempts: 0,
          totalSynced: 67890,
        },
        config: {
          enabled: true,
          autoSync: true,
          maxDevices: 120,
          protocols: ['MQTT', 'HTTP', 'BACnet'],
          storageLimit: 150,
          retentionDays: 10,
        },
        tags: ['airport', 'transportation', 'critical'],
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL EDGE INSTANCES
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const edgeData of edgeInstances) {
      try {
        const edge = this.edgeInstanceRepository.create(edgeData);
        await this.edgeInstanceRepository.save(edge);

        const statusTag =
          edge.status === EdgeStatus.ONLINE
            ? '✅ ONLINE'
            : edge.status === EdgeStatus.OFFLINE
              ? '⚫ OFFLINE'
              : edge.status === EdgeStatus.SYNCING
                ? '🔄 SYNCING'
                : '❌ ERROR';

        const healthTag = edge.isHealthy() ? '💚 HEALTHY' : '';

        this.logger.log(
          `✅ Created: ${edge.name.substring(0, 35).padEnd(37)} | ` +
          `${edge.deviceCount.toString().padStart(3)} devices | ${statusTag} ${healthTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed edge instance '${edgeData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      byStatus: {} as Record<string, number>,
      totalDevices: edgeInstances.reduce((sum, e) => sum + (e.deviceCount || 0), 0),
      healthy: edgeInstances.filter(e => {
        return (
          e.status === EdgeStatus.ONLINE &&
          (e.dataSync?.pending ?? 0) < 100 &&
          (e.metrics?.cpu ?? 0) < 80
        );
      }).length,
      withPendingSync: edgeInstances.filter(e => (e.dataSync?.pending ?? 0) > 0).length,
      totalPending: edgeInstances.reduce(
        (sum, e) => sum + (e.dataSync?.pending ?? 0),
        0,
      ),
    };

    edgeInstances.forEach((e) => {
      if (e.status) {
        summary.byStatus[e.status] = (summary.byStatus[e.status] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Edge instance seeding complete! Created ${createdCount}/${edgeInstances.length} instances.`,
    );
    this.logger.log('');
    this.logger.log('📊 Edge Instance Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   Healthy: ${summary.healthy}`);
    this.logger.log(`   Total Devices: ${summary.totalDevices}`);
    this.logger.log(`   With Pending Sync: ${summary.withPendingSync}`);
    this.logger.log(`   Total Pending Messages: ${summary.totalPending}`);
    this.logger.log('');
    this.logger.log('   By Status:');
    Object.entries(summary.byStatus).forEach(([status, count]) =>
      this.logger.log(`     - ${status.padEnd(15)}: ${count}`),
    );
  }
}