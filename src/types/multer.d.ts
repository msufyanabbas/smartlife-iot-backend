// Ambient type declaration for the `multer` npm package.
//
// `multer` 2.0.2 ships no bundled types, and `@types/multer` is not installed
// (its whole purpose is to augment the global `Express.Multer` namespace — the
// very augmentation that was breaking intermittently in the IDE with
// "Namespace 'global.Express' has no exported member 'Multer'").
//
// Instead of relying on that fragile global augmentation, we declare the module
// directly and export a `File` interface. Consumers do:
//     import type { File as MulterFile } from 'multer';
// This mirrors the ambient `coap.d.ts` declaration used elsewhere in this repo.
declare module 'multer' {
  import { Readable } from 'stream';

  // The shape of an uploaded file, as populated by multer on the request.
  export interface File {
    /** Field name specified in the form. */
    fieldname: string;
    /** Name of the file on the user's computer. */
    originalname: string;
    /** Encoding type of the file. */
    encoding: string;
    /** Mime type of the file. */
    mimetype: string;
    /** Size of the file in bytes. */
    size: number;
    /** A readable stream of the file (present with some storage engines). */
    stream: Readable;
    /** The folder to which the file has been saved (DiskStorage). */
    destination: string;
    /** The name of the file within the destination (DiskStorage). */
    filename: string;
    /** The full path to the uploaded file (DiskStorage). */
    path: string;
    /** A Buffer of the entire file (MemoryStorage). */
    buffer: Buffer;
  }
}
