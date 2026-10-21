// src/lib/storage/storage.module.ts
//
// @Global, like RedisModule: six unrelated feature modules write uploads, and
// making each one import a storage module is churn with no benefit.

import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
