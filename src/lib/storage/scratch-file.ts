// src/lib/storage/scratch-file.ts
//
// A short-lived local file for work that genuinely cannot be done remotely.
//
// ── Why this exists ────────────────────────────────────────────────────────
// `StorageService` is the seam that stops a durable artefact living on one
// replica's disk. But one step in the floor-plan pipeline is not negotiable:
// DWG → DXF conversion shells out to an EXTERNAL binary (`dwg2dxf` from
// libredwg, or ODAFileConverter). Those take a path, open it themselves, and
// know nothing about object stores. There is no buffer API to reach for.
//
// So the pattern is: pull the bytes OUT of storage, drop them in a private
// scratch directory under os.tmpdir(), run the converter, and put the RESULT
// back INTO storage. The scratch copy is derived data with a lifetime of one
// call; the durable artefact is never only on local disk.
//
// This lives here, and not in the services that use it, for a concrete reason:
// `scripts/check-cluster-safety.ts` now FAILS if `fs.writeFile` reappears in
// `floor-plans.service.ts` or `dwg-parser.service.ts`. A scratch write is the
// one legitimate exception, and burying it in a call site would have meant
// either weakening that assertion or writing an exception into it that the next
// genuine regression could hide behind. One named helper, asserted once.

import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const logger = new Logger('ScratchFile');

/** What `work` is handed: the file, and the directory it is alone in. */
export interface ScratchFile {
  /** Absolute path to the written bytes. Safe to pass to an external binary. */
  path: string;
  /**
   * The private directory containing it. A converter that writes siblings
   * (ODAFileConverter writes `<base>.dxf` next to its input) should write them
   * here, so they are removed with everything else.
   */
  directory: string;
}

/**
 * Write `bytes` to a unique scratch file, run `work`, then delete the whole
 * directory — on success, on throw, and on an early return.
 *
 * `extension` is used verbatim (a leading dot is optional) because the external
 * converters dispatch on it. It is never taken from client input at any call
 * site: the floor-plan upload validates the extension against `.dwg`/`.dxf`
 * first.
 */
export async function withScratchFile<T>(
  bytes: Buffer,
  extension: string,
  work: (file: ScratchFile) => Promise<T>,
): Promise<T> {
  const ext = extension
    ? extension.startsWith('.')
      ? extension
      : `.${extension}`
    : '';

  // mkdtemp, not a fixed name: two uploads of the same floor plan can be in
  // flight at once, and the converter writes its output beside its input. A
  // shared directory would let one call delete the other's DXF mid-parse.
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'smartlife-scratch-'),
  );
  const file = path.join(directory, `${randomUUID()}${ext}`);

  try {
    await fs.writeFile(file, bytes);
    return await work({ path: file, directory });
  } finally {
    // Never throws: the caller's result (or its error) is the interesting one,
    // and a scratch directory left behind is a tmpfs leak, not a failure.
    await fs.rm(directory, { recursive: true, force: true }).catch((error) => {
      logger.warn(
        `Could not remove scratch directory ${directory}: ${(error as Error).message}`,
      );
    });
  }
}
