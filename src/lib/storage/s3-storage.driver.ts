// src/lib/storage/s3-storage.driver.ts
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  STUB — NOT IMPLEMENTED. Setting STORAGE_DRIVER=s3 fails at boot, loudly. ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// This file is the shape of the remaining work, not the work. It exists so the
// seam is real: the call sites in images, firmware and solution-templates now
// talk to `StorageService`, so finishing this driver is one file plus a config
// value rather than an audit of every `fs.writeFile` in the tree.
//
// Why it is a stub and not an implementation:
//   • `@aws-sdk/client-s3` is NOT a dependency of this project, and
//     `npm install` is not being run (four other agents are working in this
//     node_modules).
//   • Which object store, bucket layout, credential source (instance role vs
//     static keys) and URL strategy (public bucket, CloudFront, or presigned
//     GETs) to use are deployment decisions, not code decisions. Picking them
//     here would be guessing, and the OTA download URL in particular is handed
//     to devices — a wrong guess there bricks firmware updates rather than
//     404ing a thumbnail.
//
// ── To finish it ───────────────────────────────────────────────────────────
//  1. `npm i @aws-sdk/client-s3` (and `@aws-sdk/s3-request-presigner` if the
//     bucket stays private).
//  2. Import the client DYNAMICALLY, as `AwsIotAdapter` already does in
//     src/modules/integrations/adapters — a missing SDK must degrade to a
//     failed upload, never a boot failure.
//  3. put → PutObjectCommand, get → GetObjectCommand (collect the stream),
//     delete → DeleteObjectCommand, exists → HeadObjectCommand (404 ⇒ false).
//  4. `url(key)` must return something a BROWSER and a DEVICE can both fetch.
//     If the bucket is private, that means a presigned URL, which expires —
//     and `Firmware.storagePath` / `Image.url` are persisted, so the row must
//     store the KEY and the URL must be generated per request. That is the one
//     part that needs a change outside this file.
//  5. Keep `isShared = true`. That is what makes uploads replica-safe.

import { Logger } from '@nestjs/common';
import type {
  PutOptions,
  StorageDriver,
  StoredObject,
} from './storage.interface';

const NOT_IMPLEMENTED =
  'The s3 storage driver is a stub and is not implemented. Set ' +
  'STORAGE_DRIVER=local (and STORAGE_LOCAL_SHARED=true if the upload ' +
  'directory is on shared storage), or finish src/lib/storage/s3-storage.driver.ts.';

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';

  /** True by definition — an object store is shared. Not yet reachable. */
  readonly isShared = true;

  private readonly logger = new Logger(S3StorageDriver.name);

  constructor() {
    // Fail at construction, not on the first upload. A deployment configured
    // for S3 must not accept uploads for an hour and then start losing them;
    // StorageService turns this into a named boot failure.
    this.logger.error(NOT_IMPLEMENTED);
    throw new Error(NOT_IMPLEMENTED);
  }

  put(
    _key: string,
    _body: Buffer,
    _options?: PutOptions,
  ): Promise<StoredObject> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  get(_key: string): Promise<Buffer> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  delete(_key: string): Promise<boolean> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  exists(_key: string): Promise<boolean> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  url(_key: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  localPath(): string | undefined {
    return undefined;
  }
}
