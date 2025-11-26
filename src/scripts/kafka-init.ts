// src/scripts/init-kafka.ts
// SEPARATE script - only initializes Kafka

import { kafkaService } from '../lib/kafka/kafka.service';

async function initializeKafka() {
  console.log('🚀 Initializing Kafka...\n');

  try {
    // 1. Initialize Kafka Producer
    console.log('1️⃣  Connecting to Kafka...');
    await kafkaService.initProducer();
    console.log('   ✅ Kafka Producer connected\n');

    // 2. Create Topics
    console.log('2️⃣  Creating Kafka Topics...');
    await kafkaService.createTopics();
    console.log('   ✅ Topics created\n');

    console.log('🎉 Kafka initialization completed!\n');
    console.log('📊 Kafka UI available at: http://localhost:8090\n');
  } catch (error) {
    console.error('❌ Kafka initialization failed:', error);
    process.exit(1);
  } finally {
    await kafkaService.disconnect();
    process.exit(0);
  }
}

initializeKafka();
