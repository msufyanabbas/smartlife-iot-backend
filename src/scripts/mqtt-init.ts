// src/scripts/start-mqtt-service.ts
import { mqttService } from '../lib/mqtt/mqtt.service';
import { kafkaService } from '../lib/kafka/kafka.service';

async function startMQTTService() {
  try {
    console.log('🚀 Starting MQTT Service...\n');

    // Connect to MQTT
    await mqttService.connect();

    console.log('\n✅ MQTT Service started successfully!');
    console.log('📡 Listening for device messages...\n');

    // Keep process running
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down MQTT Service...');
      await mqttService.disconnect();
      await kafkaService.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start MQTT Service:', error);
    process.exit(1);
  }
}

startMQTTService();
