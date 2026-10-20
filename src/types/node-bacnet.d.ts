// Ambient type declaration for the `node-bacnet` npm package.
//
// `@types/node-bacnet` does not exist and the package ships no bundled types —
// its `package.json` has only `"main": "index.js"`. This declaration models the
// small part of the API this platform uses (Who-Is / I-Am discovery and
// ReadProperty / ReadPropertyMultiple) rather than the whole BACnet surface,
// which is ~30 confirmed services this platform has no use for.
//
// The callback shapes below were read off `lib/client.js` and
// `lib/services/*.js` in the installed version (0.2.4), not guessed:
//
//   readProperty          → { objectId, property, values: [{ type, value }] }
//   readPropertyMultiple  → { values: [{ objectId, values: [{ id, index,
//                                        value: [{ type, value }] }] }] }
//   'iAm' event           → { header: { sender: { address } },
//                             payload: { deviceId, maxApdu, segmentation,
//                                        vendorId } }
//
// Values are deliberately loose where the library itself is loose: a BACnet
// application-tagged value can be a number, string, boolean, Date or a nested
// object, and narrowing it here would only force casts at every call site.
declare module 'node-bacnet' {
  import { EventEmitter } from 'events';

  export interface BacnetClientOptions {
    /** Local UDP port to bind. 47808 (0xBAC0) is the BACnet/IP default. */
    port?: number;
    /** Local interface to bind to. */
    interface?: string;
    /** Subnet broadcast address used by Who-Is. */
    broadcastAddress?: string;
    /** Confirmed-request timeout in milliseconds. */
    apduTimeout?: number;
    reuseAddr?: boolean;
    transport?: unknown;
  }

  export interface BacnetObjectId {
    type: number;
    instance: number;
  }

  export interface BacnetApplicationValue {
    type: number;
    value: any;
    encoding?: number;
  }

  export interface BacnetReadPropertyResult {
    objectId: BacnetObjectId;
    property: { id: number; index: number };
    values: BacnetApplicationValue[];
  }

  export interface BacnetReadAccessResultProperty {
    id: number;
    index: number;
    value: BacnetApplicationValue[];
  }

  export interface BacnetReadAccessResult {
    objectId: BacnetObjectId;
    values: BacnetReadAccessResultProperty[];
  }

  export interface BacnetReadPropertyMultipleResult {
    values: BacnetReadAccessResult[];
  }

  export interface BacnetWhoIsOptions {
    lowLimit?: number;
    highLimit?: number;
  }

  export interface BacnetIAmMessage {
    header: {
      sender: { address: string; forwardedFrom?: string | null };
      [key: string]: any;
    };
    payload: {
      deviceId: number;
      maxApdu: number;
      segmentation: number;
      vendorId: number;
    };
  }

  export interface BacnetRequestOptions {
    maxSegments?: number;
    maxApdu?: number;
    invokeId?: number;
    arrayIndex?: number;
  }

  export interface BacnetReadPropertyMultipleRequest {
    objectId: BacnetObjectId;
    properties: Array<{ id: number; index?: number }>;
  }

  /**
   * The library's enum bag, reached at runtime as `require('node-bacnet').enum`.
   *
   * Only the four members this platform reads are named; the rest are reachable
   * through the index signature rather than transcribed, because the full set
   * is several hundred entries that would drift from the library on its next
   * release.
   */
  export interface BacnetEnums {
    ObjectType: Record<string, number>;
    PropertyIdentifier: Record<string, number>;
    ApplicationTag: Record<string, number>;
    ErrorCode: Record<string, number>;
    [key: string]: Record<string, number>;
  }

  class BacnetClient extends EventEmitter {
    constructor(options?: BacnetClientOptions);

    /** Broadcasts (or unicasts, when `receiver` is given) a Who-Is. */
    whoIs(receiver?: string | BacnetWhoIsOptions, options?: BacnetWhoIsOptions): void;

    readProperty(
      receiver: string | { address: string },
      objectId: BacnetObjectId,
      propertyId: number,
      next: (err: Error | null, value?: BacnetReadPropertyResult) => void,
    ): void;
    readProperty(
      receiver: string | { address: string },
      objectId: BacnetObjectId,
      propertyId: number,
      options: BacnetRequestOptions,
      next: (err: Error | null, value?: BacnetReadPropertyResult) => void,
    ): void;

    readPropertyMultiple(
      receiver: string | { address: string },
      propertiesArray: BacnetReadPropertyMultipleRequest[],
      next: (
        err: Error | null,
        value?: BacnetReadPropertyMultipleResult,
      ) => void,
    ): void;
    readPropertyMultiple(
      receiver: string | { address: string },
      propertiesArray: BacnetReadPropertyMultipleRequest[],
      options: BacnetRequestOptions,
      next: (
        err: Error | null,
        value?: BacnetReadPropertyMultipleResult,
      ) => void,
    ): void;

    close(): void;

    on(event: 'iAm', listener: (message: BacnetIAmMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'listening', listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  /**
   * `index.js` is `module.exports = require('./lib/client')` with `.enum` and
   * `._` hung off the class itself, so the module's single export is the
   * constructor WITH those properties attached — not a namespace containing a
   * class. Typed as an intersection for that reason; `enum` is a reserved word
   * and can only be named as an object member, which is why it cannot be a
   * `declare const enum` of its own.
   */
  const BacnetModule: typeof BacnetClient & {
    enum: BacnetEnums;
    _: unknown;
  };

  export default BacnetModule;
  export { BacnetClient };
}
