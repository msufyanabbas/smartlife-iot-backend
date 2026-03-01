// src/database/seeds/node/node.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NodeType } from '@common/enums/index.enum';
import { Node, User, Tenant, RuleChain } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class NodeSeeder implements ISeeder {
  private readonly logger = new Logger(NodeSeeder.name);

  constructor(
    @InjectRepository(Node)
    private readonly nodeRepository: Repository<Node>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(RuleChain)
    private readonly ruleChainRepository: Repository<RuleChain>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting node seeding...');

    // Check if nodes already exist
    const existingNodes = await this.nodeRepository.count();
    if (existingNodes > 0) {
      this.logger.log(
        `⏭️  Nodes already seeded (${existingNodes} records). Skipping...`,
      );
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });
    const ruleChains = await this.ruleChainRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    this.logger.log(`📊 Found ${users.length} users, ${tenants.length} tenants, ${ruleChains.length} rule chains`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Use actual rule chain IDs if available, otherwise use placeholder
    const ruleChainIds = ruleChains.length > 0
      ? ruleChains.map(rc => rc.id)
      : [
        'rc-temperature-monitoring',
        'rc-alarm-processing',
        'rc-data-enrichment',
        'rc-device-lifecycle',
        'rc-energy-management',
      ];

    // ════════════════════════════════════════════════════════════════
    // NODE DATA
    // ════════════════════════════════════════════════════════════════

    const nodes: Partial<Node>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. TEMPERATURE FILTER
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[0],
        name: 'Temperature Filter',
        description: 'Filter messages based on temperature threshold',
        type: NodeType.FILTER,
        configuration: {
          script: 'return msg.temperature > 75;',
          scriptLang: 'javascript',
          successAction: 'next',
          failureAction: 'drop',
          dataKeys: ['temperature'],
          condition: {
            key: 'temperature',
            operator: 'gt',
            value: 75,
          },
        },
        position: { x: 100, y: 100 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['temperature', 'filter', 'threshold'],
        additionalInfo: {
          layoutX: 100,
          layoutY: 100,
          color: '#3B82F6',
          icon: 'filter',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 2. DEVICE TYPE FILTER
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[3],
        name: 'Device Type Filter',
        description: 'Filter by device type: sensors only',
        type: NodeType.FILTER,
        configuration: {
          script: 'return msg.deviceType === "sensor";',
          scriptLang: 'javascript',
          originatorTypes: ['DEVICE'],
          messageTypes: ['POST_TELEMETRY_REQUEST'],
        },
        position: { x: 150, y: 200 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['device', 'filter', 'sensor'],
        additionalInfo: {
          layoutX: 150,
          layoutY: 200,
          color: '#10B981',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 3. ADD TIMESTAMP ENRICHMENT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[2],
        name: 'Add Timestamp',
        description: 'Enrich message with server timestamp',
        type: NodeType.ENRICHMENT,
        configuration: {
          script: 'msg.serverTimestamp = Date.now(); return msg;',
          scriptLang: 'javascript',
          metadata: {
            addTimestamp: true,
            timezone: 'Asia/Riyadh',
          },
        },
        position: { x: 300, y: 150 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['enrichment', 'timestamp'],
        additionalInfo: {
          layoutX: 300,
          layoutY: 150,
          color: '#8B5CF6',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 4. LOCATION ENRICHMENT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        ruleChainId: ruleChainIds[2],
        name: 'Device Location Enrichment',
        description: 'Add device location metadata to messages',
        type: NodeType.ENRICHMENT,
        configuration: {
          script: `
            const deviceLocations = {
              'device-001': { lat: 24.7136, lon: 46.6753, city: 'Riyadh' },
              'device-002': { lat: 21.3891, lon: 39.8579, city: 'Jeddah' }
            };
            msg.location = deviceLocations[msg.deviceId] || { lat: 0, lon: 0, city: 'Unknown' };
            return msg;
          `,
          scriptLang: 'javascript',
          dataKeys: ['deviceId'],
          metadata: {
            enrichmentType: 'location',
          },
        },
        position: { x: 300, y: 300 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['enrichment', 'location', 'gps'],
        additionalInfo: {
          layoutX: 300,
          layoutY: 300,
          color: '#F59E0B',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 5. TEMPERATURE UNIT CONVERSION
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[0],
        name: 'Temperature Unit Conversion',
        description: 'Convert temperature from Celsius to Fahrenheit',
        type: NodeType.TRANSFORMATION,
        configuration: {
          script: 'msg.temperatureF = (msg.temperature * 9/5) + 32; return msg;',
          scriptLang: 'javascript',
          dataKeys: ['temperature'],
          mapping: {
            temp: 'temperature',
            tempF: 'temperatureF',
          },
        },
        position: { x: 250, y: 100 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['transformation', 'temperature', 'conversion'],
        additionalInfo: {
          layoutX: 250,
          layoutY: 100,
          color: '#EF4444',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 6. DATA NORMALIZATION
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        ruleChainId: ruleChainIds[2],
        name: 'Data Normalization',
        description: 'Normalize sensor data to standard format',
        type: NodeType.TRANSFORMATION,
        configuration: {
          script: `
            msg.normalized = {
              value: parseFloat(msg.value),
              unit: msg.unit || 'unknown',
              timestamp: msg.ts || Date.now()
            };
            return msg;
          `,
          scriptLang: 'javascript',
          dataKeys: ['value', 'unit', 'ts'],
        },
        position: { x: 450, y: 200 },
        connections: [],
        enabled: true,
        debugMode: true,
        tags: ['transformation', 'normalization', 'data-quality'],
        additionalInfo: {
          layoutX: 450,
          layoutY: 200,
          color: '#06B6D4',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 7. CREATE ALARM ACTION
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[1],
        name: 'Create Alarm',
        description: 'Create critical temperature alarm',
        type: NodeType.ACTION,
        configuration: {
          script: `
            return {
              alarmType: 'HIGH_TEMPERATURE',
              severity: 'CRITICAL',
              message: 'Temperature exceeded threshold: ' + msg.temperature + '°C'
            };
          `,
          scriptLang: 'javascript',
          actionType: 'email',
          successAction: 'alarm_created',
          dataKeys: ['temperature'],
          metadata: {
            alarmType: 'HIGH_TEMPERATURE',
            severity: 'CRITICAL',
          },
        },
        position: { x: 400, y: 100 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['action', 'alarm', 'critical'],
        additionalInfo: {
          layoutX: 400,
          layoutY: 100,
          color: '#DC2626',
          icon: 'alert',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 8. SEND EMAIL NOTIFICATION
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        ruleChainId: ruleChainIds[1],
        name: 'Send Email Notification',
        description: 'Send email alert to administrators',
        type: NodeType.ACTION,
        configuration: {
          script: `
            return {
              to: 'admin@example.com',
              subject: 'IoT Alert: ' + msg.alarmType,
              body: msg.message
            };
          `,
          scriptLang: 'javascript',
          actionType: 'email',
          actionConfig: {
            template: 'IoT Alert: {{alarmType}} - {{message}}',
            recipients: ['admin@example.com', 'ops@example.com'],
          },
          successAction: 'email_sent',
          metadata: {
            notificationType: 'email',
            priority: 'high',
          },
        },
        position: { x: 550, y: 100 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['action', 'email', 'notification'],
        additionalInfo: {
          layoutX: 550,
          layoutY: 100,
          color: '#EC4899',
          icon: 'mail',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 9. LOG TO CONSOLE (DISABLED FOR PRODUCTION)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        ruleChainId: ruleChainIds[2],
        name: 'Log to Console',
        description: 'Debug action to log messages to console',
        type: NodeType.ACTION,
        configuration: {
          script: 'console.log("Message:", JSON.stringify(msg)); return msg;',
          scriptLang: 'javascript',
          actionType: 'log',
          successAction: 'logged',
        },
        position: { x: 600, y: 300 },
        connections: [],
        enabled: false, // Disabled in production
        debugMode: true,
        tags: ['action', 'debug', 'logging'],
        additionalInfo: {
          layoutX: 600,
          layoutY: 300,
          color: '#6B7280',
          icon: 'terminal',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 10. REST API CALL (EXTERNAL)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        ruleChainId: ruleChainIds[2],
        name: 'REST API Call',
        description: 'Send data to external REST API',
        type: NodeType.EXTERNAL,
        configuration: {
          script: `
            const response = await fetch('https://api.example.com/data', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(msg)
            });
            return response.json();
          `,
          scriptLang: 'javascript',
          successAction: 'api_success',
          failureAction: 'api_failure',
          metadata: {
            endpoint: 'https://api.example.com/data',
            method: 'POST',
            timeout: 5000,
          },
        },
        position: { x: 700, y: 150 },
        connections: [],
        enabled: true,
        debugMode: false,
        tags: ['external', 'api', 'rest', 'http'],
        additionalInfo: {
          layoutX: 700,
          layoutY: 150,
          color: '#14B8A6',
          icon: 'cloud',
        },
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL NODES
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const nodeData of nodes) {
      try {
        const node = this.nodeRepository.create(nodeData);
        await this.nodeRepository.save(node);

        const statusTag = node.enabled ? '✅ ENABLED' : '⏸️  DISABLED';
        const debugTag = node.debugMode ? '🐛 DEBUG' : '';

        this.logger.log(
          `✅ Created: ${node.name.substring(0, 35).padEnd(37)} | ` +
          `${node.type.padEnd(15)} | ${statusTag} ${debugTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed node '${nodeData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      byType: {} as Record<string, number>,
      enabled: nodes.filter(n => n.enabled).length,
      disabled: nodes.filter(n => !n.enabled).length,
      debugMode: nodes.filter(n => n.debugMode).length,
    };

    nodes.forEach((n) => {
      if (n.type) {
        summary.byType[n.type] = (summary.byType[n.type] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Node seeding complete! Created ${createdCount}/${nodes.length} nodes.`,
    );
    this.logger.log('');
    this.logger.log('📊 Node Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   Enabled: ${summary.enabled}`);
    this.logger.log(`   Disabled: ${summary.disabled}`);
    this.logger.log(`   Debug Mode: ${summary.debugMode}`);
    this.logger.log('');
    this.logger.log('   By Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(20)}: ${count}`),
    );
  }
}