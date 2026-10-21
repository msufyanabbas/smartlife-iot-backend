// src/lib/storage/storage.service.ts
//
// Selects a driver from STORAGE_DRIVER and is what every call site injects.

import { Injectable, Logger } from '@nestjs/common';
import { envString } from '@/config/env.utils';
import { LocalStorageDriver } from './local-storage.driver';
import { S3StorageDriver } from './s3-storage.driver';
import type {
  PutOptions,
  StorageDriver,
  StoredObject,
} from './storage.interface';

@Injectable()
export class StorageService implements StorageDriver {
  private readonly logger = new Logger(StorageService.name);

  private readonly driver: StorageDriver;

  constructor() {
    const requested = (
      envString(process.env.STORAGE_DRIVER, 'local') ?? 'local'
    ).toLowerCase();

    switch (requested) {
      case 's3':
        // Throws — see the stub. Deliberately a boot failure rather than a
        // silent fallback to local: falling back would put bytes on one
        // replica's disk while the operator believes they are in a bucket.
        this.driver = new S3StorageDriver();
        break;
      case 'local':
        this.driver = new LocalStorageDriver();
        break;
      default:
        throw new Error(
          `Unknown STORAGE_DRIVER "${requested}". Supported: local, s3 (stub).`,
        );
    }

    if (this.driver.isShared) {
      this.logger.log(
        `Storage driver "${this.driver.name}" is shared — uploads are safe on multiple replicas`,
      );
    } else {
      this.logger.warn(
        `Storage driver "${this.driver.name}" is NOT shared: an upload is written to ` +
          'the local disk of whichever replica handled the request, and a later GET ' +
          'routed elsewhere will 404. Run ONE replica, mount the upload directory on ' +
          'shared storage and set STORAGE_LOCAL_SHARED=true, or implement the s3 driver.',
      );
    }
  }

  get name(): string {
    return this.driver.name;
  }

  get isShared(): boolean {
    return this.driver.isShared;
  }

  /** Which driver is active, for /health and the guard script. */
  describe(): { driver: string; shared: boolean } {
    return { driver: this.driver.name, shared: this.driver.isShared };
  }

  put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    return this.driver.put(key, body, options);
  }

  get(key: string): Promise<Buffer> {
    return this.driver.get(key);
  }

  delete(key: string): Promise<boolean> {
    return this.driver.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  url(key: string): string {
    return this.driver.url(key);
  }

  localPath(key: string): string | undefined {
    return this.driver.localPath(key);
  }
}
