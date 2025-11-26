// src/scripts/consumers-start.ts
// This script starts all Kafka consumers

import { Pool } from 'pg';
import { kafkaService } from '../lib/kafka/kafka.service';
import { redisService } from '../lib/redis/redis.service';
import { TelemetryConsumer } from '../modules/telemetry/telemetry.consumer';
import { mqttService } from '@/lib/mqtt/mqtt.service';
import { AuditConsumer } from '@/modules/audit/audit.consumer';
import { AlarmConsumer } from '@/modules/alarms/alarms.consumer';
import { DeviceCommandsConsumer } from '@/modules/device-commands/device-commands.consumer';

async function startConsumers() {
  console.log('🚀 Starting Kafka Consumers...\n');

  try {
    // Connect to services
    console.log('📡 Connecting to services...');
    await redisService.connect();
    await kafkaService.initProducer();
    await mqttService.connect();
    console.log('✅ Services connected\n');

    // Initialize database connection
    const db = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || '5432',
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD || 'postgres',
    });

    console.log('📊 Starting consumers...\n');

    // 1. Start Telemetry Consumer
    console.log('1️⃣  Starting Telemetry Consumer...');
    const telemetryConsumer = new TelemetryConsumer(db);
    await telemetryConsumer.start();

    // 2. Add more consumers here as you implement them
    const deviceConsumer = new DeviceCommandsConsumer(db);
    await deviceConsumer.start();

    const alarmConsumer = new AlarmConsumer(db);
    await alarmConsumer.start();

    const auditConsumer = new AuditConsumer(db);
    await auditConsumer.start();

    console.log('\n✅ All consumers started successfully!');
    console.log('📊 Monitoring for messages...\n');

    // Keep process running
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down consumers...');
      await kafkaService.disconnect();
      await redisService.disconnect();
      await db.end();
      console.log('✅ Shutdown complete');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start consumers:', error);
    process.exit(1);
  }
}

// Start consumers
startConsumers();
