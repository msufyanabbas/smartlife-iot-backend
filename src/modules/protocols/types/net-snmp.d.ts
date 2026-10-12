/**
 * Ambient type declaration for the `net-snmp` npm package.
 *
 * `net-snmp@3` ships no bundled types and `@types/net-snmp` does not exist on
 * npm, so this mirrors the pattern already used for the `coap` package in
 * `src/types/coap.d.ts`. It is deliberately minimal: only the surface the SNMP
 * poller (and the in-process agent fixture under `scripts/`) actually touches
 * is modelled. Anything else is reachable through the index signature rather
 * than being described here, because modelling the whole SMI/MIB surface would
 * be a maintenance burden with no payoff.
 *
 * This file lives inside the protocols module rather than `src/types/` so the
 * declaration sits with the only code that consumes it.
 */
declare module 'net-snmp' {
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export const Version: Record<string, number | string>;

  /** ASN.1 / SMI value tags. Indexable both ways (name → tag, tag → name). */
  export const ObjectType: Record<string, any> & {
    Boolean: number;
    Integer: number;
    OctetString: number;
    Null: number;
    OID: number;
    IpAddress: number;
    Counter: number;
    Gauge: number;
    TimeTicks: number;
    Opaque: number;
    Counter64: number;
    NoSuchObject: number;
    NoSuchInstance: number;
    EndOfMibView: number;
  };

  export const ErrorStatus: Record<string, any>;
  export const MaxAccess: Record<string, number>;
  export const MibProviderType: Record<string, number> & {
    Scalar: number;
    Table: number;
  };

  export const SecurityLevel: Record<string, any> & {
    noAuthNoPriv: number;
    authNoPriv: number;
    authPriv: number;
  };
  export const AuthProtocols: Record<string, any>;
  export const PrivProtocols: Record<string, any>;

  /** One OID/value pair as returned by a GET / GETNEXT / walk. */
  export interface Varbind {
    oid: string;
    type: number;
    value: any;
  }

  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    transport?: 'udp4' | 'udp6';
    trapPort?: number;
    version?: number;
    backwardsGetNexts?: boolean;
    idBitsSize?: number;
    context?: string;
    [key: string]: any;
  }

  /** SNMPv3 USM user. */
  export interface V3User {
    name: string;
    level?: number;
    authProtocol?: any;
    authKey?: string;
    privProtocol?: any;
    privKey?: string;
    [key: string]: any;
  }

  export interface Session {
    get(
      oids: string[],
      callback: (error: Error | null, varbinds: Varbind[]) => void,
    ): void;
    getNext(
      oids: string[],
      callback: (error: Error | null, varbinds: Varbind[]) => void,
    ): void;
    set(
      varbinds: Array<{ oid: string; type: number; value: any }>,
      callback: (error: Error | null, varbinds: Varbind[]) => void,
    ): void;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    [key: string]: any;
  }

  export function createSession(
    target: string,
    community: string,
    options?: SessionOptions,
  ): Session;

  export function createV3Session(
    target: string,
    user: V3User,
    options?: SessionOptions,
  ): Session;

  /** True when a varbind carries an SNMP "no such object/instance" tag. */
  export function isVarbindError(varbind: Varbind): boolean;
  export function varbindError(varbind: Varbind): string;

  // ── Agent side (used only by the test fixture) ──────────────────────────
  export interface MibProvider {
    name: string;
    type: number;
    oid: string;
    scalarType?: number;
    maxAccess?: number;
    [key: string]: any;
  }

  export interface Mib {
    registerProvider(provider: MibProvider): void;
    setScalarValue(name: string, value: any): void;
    getScalarValue(name: string): any;
    [key: string]: any;
  }

  export interface Authorizer {
    addCommunity(community: string): void;
    addUser(user: V3User): void;
    [key: string]: any;
  }

  export interface Agent {
    getMib(): Mib;
    getAuthorizer(): Authorizer;
    close(callback?: () => void): void;
    [key: string]: any;
  }

  export function createAgent(
    options: { port?: number; disableAuthorization?: boolean; [key: string]: any },
    callback?: (error: Error | null, data?: any) => void,
    mib?: any,
  ): Agent;

  export function createModuleStore(): any;
}
