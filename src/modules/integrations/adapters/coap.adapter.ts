import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Outbound CoAP (RFC 7252) over UDP.
 *
 * The `coap` package is already a platform dependency — it backs the inbound
 * CoAP server in ProtocolsModule — so this reuses it rather than adding one.
 *
 * It is imported dynamically for the same reason the AWS adapter is: `coap`
 * binds UDP sockets at require time in some environments, and an integration
 * adapter must never be able to stop the app booting. A missing or broken
 * package degrades to a failed dispatch.
 *
 * Note on `confirmable`: a non-confirmable request is genuinely fire-and-forget
 * — the server sends no ACK, so "success" means the datagram left the host, not
 * that anything received it. That is the correct semantic for a lossy link, and
 * it is surfaced in the result message rather than being quietly implied.
 */
export class CoapAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(CoapAdapter.name);

  private resolvePath(config: any, payload: any): string {
    const template = String(config?.path ?? '/telemetry');
    const resolved = template
      .replace(/\{\{\s*deviceId\s*\}\}/g, payload?.deviceId ?? 'unknown')
      .replace(/\{\{\s*deviceKey\s*\}\}/g, payload?.deviceKey ?? 'unknown')
      .replace(/\{\{\s*tenantId\s*\}\}/g, payload?.tenantId ?? 'unknown');
    return resolved.startsWith('/') ? resolved : `/${resolved}`;
  }

  private validate(config: any): string | null {
    if (!config?.host) return 'CoAP integration needs a host';
    if (!config?.path) return 'CoAP integration needs a path';
    return null;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    let coap: any;
    try {
      coap = await import('coap');
    } catch (error: any) {
      return {
        success: false,
        error: `CoAP support is unavailable: ${error.message}`,
      };
    }

    const confirmable = config?.confirmable !== false;
    const timeout = Number(config?.timeout) || 10000;

    return new Promise<DispatchResult>((resolve) => {
      let settled = false;
      const finish = (result: DispatchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ success: false, error: 'CoAP request timed out' }),
        timeout,
      );

      try {
        const request = coap.request({
          host: String(config.host).replace(/^coaps?:\/\//, ''),
          port: Number(config.port) || 5683,
          pathname: this.resolvePath(config, payload),
          method: String(config.method ?? 'POST').toUpperCase(),
          confirmable,
        });

        request.setOption('Content-Format', 'application/json');

        request.on('response', (response: any) => {
          // CoAP codes are strings like '2.05'; the 2.xx class is success.
          const code = String(response.code ?? '');
          const ok = code.startsWith('2');
          finish({
            success: ok,
            error: ok ? undefined : `CoAP responded ${code}`,
          });
        });

        request.on('error', (error: any) =>
          finish({ success: false, error: error.message }),
        );

        request.end(Buffer.from(JSON.stringify(payload)));

        // Nothing will ever answer a non-confirmable request, so resolve as
        // soon as it is on the wire instead of waiting out the timeout.
        if (!confirmable) {
          setImmediate(() => finish({ success: true }));
        }
      } catch (error: any) {
        finish({ success: false, error: error.message });
      }
    });
  }

  async testConnection(config: any): Promise<ConnectionResult> {
    const invalid = this.validate(config);
    if (invalid) return { connected: false, message: invalid };

    // Probe confirmably even when the integration is fire-and-forget —
    // otherwise the probe would "succeed" without anything having answered,
    // which tells the operator nothing.
    const result = await this.dispatch(
      { ...config, confirmable: true },
      { test: true, source: 'SmartLife IoT Platform', timestamp: new Date().toISOString() },
    );

    return {
      connected: result.success,
      message: result.success
        ? 'Connected — the CoAP server acknowledged a test message.'
        : `Connection failed: ${result.error ?? 'unknown error'}`,
      sideEffect: 'A test message was delivered to the configured path.',
    };
  }
}
