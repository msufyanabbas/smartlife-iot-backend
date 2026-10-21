// src/lib/storage/storage.interface.ts
//
// The seam between "the platform stores a file" and "the file is on this
// container's disk".
//
// ── Why this exists ────────────────────────────────────────────────────────
// Six places wrote uploads with `fs.writeFile` into `./uploads` and handed the
// client back a `/uploads/...` URL served by `app.useStaticAssets()` in
// main.ts: images, firmware binaries, floor-plan DWG/DXF source, DWG preview
// thumbnails, generated 3D models, solution-template images and report
// artefacts.
//
// On one container that is fine. Behind a load balancer it is not: the bytes
// land on the replica that handled the POST, and the next GET — of the image,
// of the firmware binary a DEVICE is told to download for OTA, of a generated
// report — is routed to a different replica, where the path does not exist.
// The result is a 404 roughly (N-1)/N of the time, with no error anywhere in
// the logs because nothing failed.
//
// ── What this is, and what it deliberately is not ──────────────────────────
// This is NOT an S3 integration. It is the seam that makes one possible: a
// narrow interface, a `local` driver that is byte-for-byte the current
// behaviour, and an `s3` driver that is an explicit, loud stub. The call sites
// stop naming `fs` and start naming a key, so adding a real object-store
// driver later is one new file plus a config value — not an audit of six
// services.
//
// Until an object store (or a shared volume — see STORAGE_DRIVER in §8 of
// CLAUDE.md) is in place, uploads remain the one genuinely
// single-instance-only part of the platform.

/** What a driver returns once the bytes are durably written. */
export interface StoredObject {
  /**
   * The driver-independent identity of the object: a relative, POSIX-style
   * path such as `images/9f3c….png`. This is what a database row should store,
   * NOT an absolute filesystem path — an absolute path is what ties a row to
   * one container.
   */
  key: string;
  /** Where a browser or a device can fetch it. */
  url: string;
  size: number;
  /** For the local driver, the absolute path. Undefined for remote drivers. */
  localPath?: string;
}

export interface PutOptions {
  contentType?: string;
  /** Hint only; a driver may ignore it. */
  cacheSeconds?: number;
}

export interface StorageDriver {
  /** `local` | `s3`. Recorded on rows that have a `storageProvider` column. */
  readonly name: string;

  /**
   * True when two replicas see the same bytes. The local driver reports false
   * unless STORAGE_LOCAL_SHARED=true says the upload directory is a shared
   * volume (NFS, EFS, a Docker volume on one host), which is the other valid
   * way to run uploads on more than one replica.
   */
  readonly isShared: boolean;

  put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  /** The URL for an already-stored key, without touching the object. */
  url(key: string): string;
  /** Absolute local path, when the driver has one. */
  localPath(key: string): string | undefined;
}
