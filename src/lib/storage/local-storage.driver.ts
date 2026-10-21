// src/lib/storage/local-storage.driver.ts
//
// The current behaviour, behind the interface. Nothing about where bytes land
// or what URL is produced changes when this driver is selected — that is the
// point: switching the call sites over must be a no-op on one instance.

import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { envBoolean, envString } from '@/config/env.utils';
import type {
  PutOptions,
  StorageDriver,
  StoredObject,
} from './storage.interface';

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';

  private readonly logger = new Logger(LocalStorageDriver.name);

  /** Absolute root. Mirrors what main.ts serves with useStaticAssets(). */
  private readonly root: string;

  /** URL prefix. Mirrors UPLOAD_URL_PREFIX, for the same reason. */
  private readonly prefix: string;

  private readonly shared: boolean;

  /**
   * First key segment → an absolute directory that replaces `<root>/<segment>`.
   *
   * Three services already shipped their own directory override, all of them
   * documented env vars: `UPLOAD_PATH_IMAGES`, `FIRMWARE_STORAGE_DIR` and
   * `UPLOAD_PATH_TEMPLATES`. Honouring them here is what makes moving those
   * call sites onto this driver a no-op — without it, an operator who had
   * pointed firmware at a dedicated volume would silently start writing
   * somewhere else after a deploy.
   */
  private readonly rootOverrides: Record<string, string>;

  constructor() {
    const uploadPath = envString(process.env.UPLOAD_PATH, './uploads')!;
    this.root = path.resolve(process.cwd(), uploadPath);
    this.prefix = (
      envString(process.env.UPLOAD_URL_PREFIX, '/uploads') ?? '/uploads'
    ).replace(/\/+$/, '');

    // An operator who has mounted the upload directory on shared storage — an
    // NFS/EFS mount, or a single-host Docker volume attached to every replica —
    // is running local storage safely across replicas. There is no way to
    // detect that from inside the process, so it is declared.
    this.shared = envBoolean(process.env.STORAGE_LOCAL_SHARED, false);

    this.rootOverrides = {};
    const images = envString(process.env.UPLOAD_PATH_IMAGES);
    if (images) this.rootOverrides.images = path.resolve(process.cwd(), images);
    const firmware = envString(process.env.FIRMWARE_STORAGE_DIR);
    if (firmware) {
      this.rootOverrides.firmware = path.resolve(process.cwd(), firmware);
    }
    const templates = envString(process.env.UPLOAD_PATH_TEMPLATES);
    if (templates) {
      this.rootOverrides['solution-templates'] = path.resolve(
        process.cwd(),
        templates,
      );
    }
  }

  get isShared(): boolean {
    return this.shared;
  }

  async put(
    key: string,
    body: Buffer,
    _options?: PutOptions,
  ): Promise<StoredObject> {
    const absolute = this.resolve(key);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);

    return {
      key: this.normalise(key),
      url: this.url(key),
      size: body.length,
      localPath: absolute,
    };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.resolve(key));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Already gone is a success for a delete — callers use this on cleanup
      // paths where throwing would mask the original failure.
      if (code === 'ENOENT') return false;
      this.logger.warn(`Could not delete ${key}: ${(error as Error).message}`);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  url(key: string): string {
    return `${this.prefix}/${this.normalise(key)}`;
  }

  localPath(key: string): string | undefined {
    return this.resolve(key);
  }

  /** POSIX-style, no leading slash, no `..`. */
  private normalise(key: string): string {
    return key.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  /**
   * Join under the root and refuse to escape it.
   *
   * Keys are server-generated everywhere today (a uuid, or an entity id plus a
   * validated extension), but a traversal check at the one place every write
   * goes through costs nothing and means a future caller that forwards part of
   * a filename cannot write outside the upload directory.
   */
  private resolve(key: string): string {
    const normalised = this.normalise(key);
    const slash = normalised.indexOf('/');
    const segment = slash === -1 ? normalised : normalised.slice(0, slash);
    const override = this.rootOverrides[segment];

    const base = override ?? this.root;
    const rest = override ? normalised.slice(slash === -1 ? 0 : slash + 1) : normalised;
    const absolute = path.resolve(base, rest);

    if (absolute !== base && !absolute.startsWith(base + path.sep)) {
      throw new Error(`Storage key escapes its storage root: ${key}`);
    }
    return absolute;
  }
}
