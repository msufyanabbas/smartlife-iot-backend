// src/lib/cluster/cluster.module.ts
//
// @Global because `@DistributedCron` reaches the lock service through a static
// holder rather than DI (see the decorator), and because any service that
// wants `withLock()` directly should be able to inject it without its module
// importing anything. RedisModule is itself @Global, so RedisService resolves.

import { Global, Module } from '@nestjs/common';
import { DistributedLockService } from './distributed-lock.service';

@Global()
@Module({
  providers: [DistributedLockService],
  exports: [DistributedLockService],
})
export class ClusterModule {}
