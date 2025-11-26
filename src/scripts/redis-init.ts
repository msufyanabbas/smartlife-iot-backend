// src/scripts/init-redis.ts
// SEPARATE script - only initializes Redis

import { redisService } from '../lib/redis/redis.service';

async function initializeRedis() {
  console.log('🚀 Initializing Redis...\n');

  try {
    // 1. Connect to Redis
    console.log('1️⃣  Connecting to Redis...');
    await redisService.connect();
    console.log('   ✅ Redis connected\n');

    // 2. Test Redis
    console.log('2️⃣  Testing Redis...');
    const ping = await redisService.ping();

    if (ping) {
      console.log('   ✅ Redis test passed\n');
    } else {
      throw new Error('Redis ping failed');
    }

    // 3. Get Redis info
    console.log('3️⃣  Redis Info:');
    const info = await redisService.client.info('server');
    const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
    console.log(`   Version: ${version}\n`);

    console.log('🎉 Redis initialization completed!\n');
    console.log('📊 Redis UI available at: http://localhost:8091\n');
  } catch (error) {
    console.error('❌ Redis initialization failed:', error);
    process.exit(1);
  } finally {
    await redisService.disconnect();
    process.exit(0);
  }
}

initializeRedis();
