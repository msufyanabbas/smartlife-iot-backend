// src/common/utils/websocket-cors.ts
//
// Gateway decorators are evaluated at *import* time, before Nest builds the
// injector — so a gateway cannot inject ConfigService to decide its CORS origin.
// That is why the two gateways read process.env directly. This helper keeps that
// necessary compromise in one place and fixes what was wrong with it:
//
//   * The two gateways disagreed. WebsocketGateway read FRONTEND_URL and
//     AlarmsGateway read CORS_ORIGIN, so a deployment that set only one ended up
//     with one socket endpoint locked down and the other wide open to '*'.
//   * Neither split on commas, so a multi-origin CORS_ORIGIN was compared as one
//     long string and matched nothing.
//
// `config/load-env` is imported for its side effect so the variables are present
// even though this runs before ConfigModule initialises.

import '@/config/load-env';

/**
 * Resolves the allowed WebSocket origins.
 *
 * CORS_ORIGIN is authoritative and FRONTEND_URL is the fallback, matching the
 * precedence the HTTP layer uses in main.ts. Returns `true` (reflect the request
 * origin) only for an explicit wildcard — Socket.IO treats `true` and `'*'`
 * differently once credentials are involved.
 */
export function websocketCorsOrigin(): string[] | boolean {
  const raw = (
    process.env.CORS_ORIGIN ??
    process.env.FRONTEND_URL ??
    '*'
  ).trim();

  if (raw === '*') return true;

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : true;
}

/**
 * Whether credentials may be sent on the socket handshake. Forced off for a
 * wildcard origin, which browsers reject on credentialed requests.
 */
export function websocketCorsCredentials(): boolean {
  const origin = websocketCorsOrigin();
  if (origin === true) return false;
  return process.env.CORS_CREDENTIALS !== 'false';
}
