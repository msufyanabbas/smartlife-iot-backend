// src/modules/integrations/adapters/adapter.interface.ts

/** Outcome of a single outbound dispatch. Adapters never throw — they resolve. */
export interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/** Outcome of a connectivity probe. */
export interface ConnectionResult {
  connected: boolean;
  message: string;
  /** Adapter-specific extras (e.g. Tuya returns deviceCount). */
  [key: string]: unknown;
}

/**
 * Every adapter is a plain class (not a Nest provider) so the dispatcher can
 * hold one instance per type without DI ceremony. The contract is deliberately
 * total: a failing endpoint must come back as `{success: false}`, never as a
 * rejected promise, because a dispatch failure must not break the telemetry
 * pipeline.
 */
export interface IIntegrationAdapter {
  dispatch(config: any, payload: any): Promise<DispatchResult>;
  testConnection(config: any): Promise<ConnectionResult>;
}
