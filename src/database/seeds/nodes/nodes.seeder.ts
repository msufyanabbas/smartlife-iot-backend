import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NodeType } from '@modules/nodes/entities/node.entity';
import { Node, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class NodeSeeder implements ISeeder {
  constructor(
    @InjectRepository(Node)
    private readonly nodeRepository: Repository<Node>,
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

    // Generate some fake rule chain IDs for reference
    const ruleChainIds = [
      'rc_temperature_monitoring',
      'rc_alarm_processing',
      'rc_data_enrichment',
      'rc_device_lifecycle',
      'rc_energy_management',
    ];

    const nodes = [
      {
        name: 'Temperature Filter',
        description: 'Filter messages based on temperature threshold',
        type: NodeType.FILTER,
        ruleChainId: ruleChainIds[0],
        configuration: {
          script: 'return msg.temperature > 75;',
          scriptLang: 'JavaScript',
          successAction: 'next',
          failureAction: 'drop',
          dataKeys: ['temperature'],
        },
        position: { x: 100, y: 100 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 100,
          layoutY: 100,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Device Type Filter',
        description: 'Filter by device type: sensors only',
        type: NodeType.FILTER,
        ruleChainId: ruleChainIds[3],
        configuration: {
          script: 'return msg.deviceType === "sensor";',
          scriptLang: 'JavaScript',
          originatorTypes: ['DEVICE'],
          messageTypes: ['POST_TELEMETRY_REQUEST'],
        },
        position: { x: 150, y: 200 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 150,
          layoutY: 200,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Add Timestamp',
        description: 'Enrich message with server timestamp',
        type: NodeType.ENRICHMENT,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: 'msg.serverTimestamp = Date.now(); return msg;',
          scriptLang: 'JavaScript',
          metadata: {
            addTimestamp: true,
            timezone: 'Asia/Riyadh',
          },
        },
        position: { x: 300, y: 150 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 300,
          layoutY: 150,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Device Location Enrichment',
        description: 'Add device location metadata to messages',
        type: NodeType.ENRICHMENT,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            const deviceLocations = {
              'device-001': { lat: 24.7136, lon: 46.6753, city: 'Riyadh' },
              'device-002': { lat: 21.3891, lon: 39.8579, city: 'Jeddah' }
            };
            msg.location = deviceLocations[msg.deviceId] || { lat: 0, lon: 0, city: 'Unknown' };
            return msg;
          `,
          scriptLang: 'JavaScript',
          dataKeys: ['deviceId'],
          metadata: {
            enrichmentType: 'location',
          },
        },
        position: { x: 300, y: 300 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 300,
          layoutY: 300,
        },
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Temperature Unit Conversion',
        description: 'Convert temperature from Celsius to Fahrenheit',
        type: NodeType.TRANSFORMATION,
        ruleChainId: ruleChainIds[0],
        configuration: {
          script:
            'msg.temperatureF = (msg.temperature * 9/5) + 32; return msg;',
          scriptLang: 'JavaScript',
          dataKeys: ['temperature'],
        },
        position: { x: 250, y: 100 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 250,
          layoutY: 100,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Data Normalization',
        description: 'Normalize sensor data to standard format',
        type: NodeType.TRANSFORMATION,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            msg.normalized = {
              value: parseFloat(msg.value),
              unit: msg.unit || 'unknown',
              timestamp: msg.ts || Date.now()
            };
            return msg;
          `,
          scriptLang: 'JavaScript',
          dataKeys: ['value', 'unit', 'ts'],
        },
        position: { x: 450, y: 200 },
        enabled: true,
        debugMode: true,
        additionalInfo: {
          layoutX: 450,
          layoutY: 200,
        },
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Create Alarm',
        description: 'Create critical temperature alarm',
        type: NodeType.ACTION,
        ruleChainId: ruleChainIds[1],
        configuration: {
          script: `
            return {
              alarmType: 'HIGH_TEMPERATURE',
              severity: 'CRITICAL',
              message: 'Temperature exceeded threshold: ' + msg.temperature + '°C'
            };
          `,
          scriptLang: 'JavaScript',
          successAction: 'alarm_created',
          dataKeys: ['temperature'],
          metadata: {
            alarmType: 'HIGH_TEMPERATURE',
            severity: 'CRITICAL',
          },
        },
        position: { x: 400, y: 100 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 400,
          layoutY: 100,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Send Email Notification',
        description: 'Send email alert to administrators',
        type: NodeType.ACTION,
        ruleChainId: ruleChainIds[1],
        configuration: {
          script: `
            return {
              to: 'admin@example.com',
              subject: 'IoT Alert: ' + msg.alarmType,
              body: msg.message
            };
          `,
          scriptLang: 'JavaScript',
          successAction: 'email_sent',
          metadata: {
            notificationType: 'email',
            priority: 'high',
          },
        },
        position: { x: 550, y: 100 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 550,
          layoutY: 100,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Log to Console',
        description: 'Debug action to log messages to console',
        type: NodeType.ACTION,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: 'console.log("Message:", JSON.stringify(msg)); return msg;',
          scriptLang: 'JavaScript',
          successAction: 'logged',
        },
        position: { x: 600, y: 300 },
        enabled: false,
        debugMode: true,
        additionalInfo: {
          layoutX: 600,
          layoutY: 300,
        },
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'REST API Call',
        description: 'Send data to external REST API',
        type: NodeType.EXTERNAL,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            const response = await fetch('https://api.example.com/data', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(msg)
            });
            return response.json();
          `,
          scriptLang: 'JavaScript',
          successAction: 'api_success',
          failureAction: 'api_failure',
          metadata: {
            endpoint: 'https://api.example.com/data',
            method: 'POST',
          },
        },
        position: { x: 700, y: 150 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 700,
          layoutY: 150,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'AWS Lambda Integration',
        description: 'Invoke AWS Lambda function for processing',
        type: NodeType.EXTERNAL,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            // AWS Lambda invocation logic
            return { status: 'lambda_invoked', result: msg };
          `,
          scriptLang: 'JavaScript',
          metadata: {
            functionName: 'iot-data-processor',
            region: 'us-east-1',
          },
        },
        position: { x: 700, y: 300 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 700,
          layoutY: 300,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Energy Monitoring Flow',
        description: 'Sub-flow for energy consumption monitoring',
        type: NodeType.FLOW,
        ruleChainId: ruleChainIds[4],
        configuration: {
          script: 'return msg;',
          scriptLang: 'JavaScript',
          messageTypes: ['POST_TELEMETRY_REQUEST'],
          dataKeys: ['power', 'energy', 'voltage', 'current'],
        },
        position: { x: 200, y: 400 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 200,
          layoutY: 400,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Device Lifecycle Flow',
        description: 'Handle device provisioning and decommissioning',
        type: NodeType.FLOW,
        ruleChainId: ruleChainIds[3],
        configuration: {
          messageTypes: ['DEVICE_CREATED', 'DEVICE_UPDATED', 'DEVICE_DELETED'],
          originatorTypes: ['DEVICE'],
          metadata: {
            flowType: 'lifecycle',
          },
        },
        position: { x: 200, y: 550 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 200,
          layoutY: 550,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Humidity Range Filter',
        description:
          'Filter messages where humidity is within acceptable range',
        type: NodeType.FILTER,
        ruleChainId: ruleChainIds[0],
        configuration: {
          script: 'return msg.humidity >= 30 && msg.humidity <= 70;',
          scriptLang: 'JavaScript',
          successAction: 'in_range',
          failureAction: 'out_of_range',
          dataKeys: ['humidity'],
        },
        position: { x: 100, y: 250 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 100,
          layoutY: 250,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Battery Level Check',
        description: 'Filter devices with low battery',
        type: NodeType.FILTER,
        ruleChainId: ruleChainIds[3],
        configuration: {
          script: 'return msg.battery < 20;',
          scriptLang: 'JavaScript',
          successAction: 'low_battery',
          failureAction: 'battery_ok',
          dataKeys: ['battery'],
          metadata: {
            threshold: 20,
            unit: 'percentage',
          },
        },
        position: { x: 100, y: 400 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 100,
          layoutY: 400,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Add Device Metadata',
        description: 'Enrich with device attributes and metadata',
        type: NodeType.ENRICHMENT,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            msg.deviceMetadata = {
              model: 'IoT-Sensor-v2',
              manufacturer: 'TechCorp',
              firmwareVersion: '2.3.1'
            };
            return msg;
          `,
          scriptLang: 'JavaScript',
          dataKeys: ['deviceId'],
        },
        position: { x: 300, y: 450 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 300,
          layoutY: 450,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Calculate Average',
        description: 'Calculate moving average of sensor readings',
        type: NodeType.TRANSFORMATION,
        ruleChainId: ruleChainIds[0],
        configuration: {
          script: `
            if (!state.readings) state.readings = [];
            state.readings.push(msg.value);
            if (state.readings.length > 10) state.readings.shift();
            msg.average = state.readings.reduce((a, b) => a + b, 0) / state.readings.length;
            return msg;
          `,
          scriptLang: 'JavaScript',
          dataKeys: ['value'],
          metadata: {
            windowSize: 10,
          },
        },
        position: { x: 450, y: 350 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 450,
          layoutY: 350,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Save to Database',
        description: 'Persist telemetry data to timeseries database',
        type: NodeType.ACTION,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: 'return { operation: "save_timeseries", data: msg };',
          scriptLang: 'JavaScript',
          successAction: 'saved',
          failureAction: 'save_failed',
        },
        position: { x: 550, y: 250 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 550,
          layoutY: 250,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Publish to MQTT',
        description: 'Publish processed data to MQTT topic',
        type: NodeType.EXTERNAL,
        ruleChainId: ruleChainIds[2],
        configuration: {
          script: `
            return {
              topic: 'processed/data/' + msg.deviceId,
              payload: JSON.stringify(msg),
              qos: 1
            };
          `,
          scriptLang: 'JavaScript',
          metadata: {
            broker: 'mqtt.example.com',
            port: 1883,
          },
        },
        position: { x: 700, y: 450 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 700,
          layoutY: 450,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Anomaly Detection Flow',
        description: 'Machine learning-based anomaly detection pipeline',
        type: NodeType.FLOW,
        ruleChainId: ruleChainIds[2],
        configuration: {
          messageTypes: ['POST_TELEMETRY_REQUEST'],
          dataKeys: ['temperature', 'humidity', 'pressure'],
          metadata: {
            flowType: 'ml_pipeline',
            modelVersion: '1.2.0',
          },
        },
        position: { x: 200, y: 700 },
        enabled: true,
        debugMode: false,
        additionalInfo: {
          layoutX: 200,
          layoutY: 700,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const nodeData of nodes) {
      const existing = await this.nodeRepository.findOne({
        where: { name: nodeData.name, userId: nodeData.userId },
      });

      if (!existing) {
        const node = this.nodeRepository.create(nodeData);
        await this.nodeRepository.save(node);
        console.log(`✅ Created node: ${nodeData.name} (${nodeData.type})`);
      } else {
        console.log(`⏭️  Node already exists: ${nodeData.name}`);
      }
    }

    console.log('🎉 Node seeding completed!');
  }
}
