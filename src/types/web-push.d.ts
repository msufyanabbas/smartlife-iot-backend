// Ambient type declaration for the `web-push` npm package.
//
// `web-push` ships no bundled types (no `types`/`typings` field, no index.d.ts)
// and `@types/web-push` is not installed in this repo — and installing it is
// not an option here, so this declaration covers the surface PushChannel uses
// rather than the whole library.
//
// Same approach as `src/types/coap.d.ts`: narrow and honest. If a later change
// needs `generateVAPIDKeys` or the `encrypt` helpers, add them here.
declare module 'web-push' {
  export interface PushSubscriptionKeys {
    p256dh: string;
    auth: string;
  }

  export interface PushSubscriptionJSON {
    endpoint: string;
    expirationTime?: number | null;
    keys: PushSubscriptionKeys;
  }

  export interface RequestOptions {
    TTL?: number;
    headers?: Record<string, string>;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    topic?: string;
    timeout?: number;
    contentEncoding?: 'aes128gcm' | 'aesgcm';
    proxy?: string;
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  /**
   * Thrown for any non-2xx response. `statusCode` is the field that matters:
   * 404 and 410 mean the subscription is gone and must be pruned.
   */
  export class WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscriptionJSON,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>;

  export function generateVAPIDKeys(): {
    publicKey: string;
    privateKey: string;
  };
}
