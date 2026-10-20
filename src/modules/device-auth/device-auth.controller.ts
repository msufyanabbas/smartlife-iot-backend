import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';

import { DeviceAuthService } from './device-auth.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EMQX authentication and authorization webhooks
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MQTT was the one ingest path this platform could not secure in application
 * code, because the broker accepts the connection before a single message
 * reaches NestJS. The codebase acknowledged this ("MQTT auth lives in EMQX")
 * while shipping an EMQX that ran on its default `admin/public` with
 * `allow_anonymous = true` — so the delegation pointed at nothing.
 *
 * EMQX 5 can delegate both decisions over HTTP. These two endpoints are what
 * it calls:
 *
 *   authn → "is this clientid/username/password a real device?"
 *   authz → "may THIS device publish or subscribe to THIS topic?"
 *
 * Both are needed. Authentication alone would let any device that holds valid
 * credentials publish on every other device's topic, which is the same
 * forgery problem one level up: knowing your own token would be enough to
 * fake every other device in the tenant.
 *
 * Wiring (see `docker/emqx/emqx.conf`):
 *   authentication = [{ mechanism = password_based, backend = http,
 *                       url = "http://app:5000/device-auth/mqtt/authn" }]
 *   authorization.sources = [{ type = http,
 *                       url = "http://app:5000/device-auth/mqtt/authz" }]
 *
 * These are `@Public()` because the caller is the broker, not a signed-in
 * user. They are reachable only on the internal Docker network, they are
 * rate limited, and they answer `deny` on anything they do not recognise —
 * including on their own internal errors.
 */
@ApiTags('device-auth')
@Controller('device-auth')
export class DeviceAuthController {
  constructor(private readonly deviceAuth: DeviceAuthService) {}

  /**
   * EMQX password-based HTTP authentication.
   *
   * EMQX treats a 200 with `{"result":"allow"}` as success and anything else
   * — including a non-200 — as a denial, so an outage of this endpoint fails
   * closed rather than opening the broker.
   */
  @Post('mqtt/authn')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async mqttAuthn(
    @Body()
    body: {
      clientid?: string;
      username?: string;
      password?: string;
      peerhost?: string;
    },
  ): Promise<{ result: 'allow' | 'deny'; is_superuser?: boolean }> {
    const username = body?.username ?? body?.clientid;
    if (!username) return { result: 'deny' };

    // ── The platform's own backend client ─────────────────────────────────
    //
    // `lib/mqtt/MQTTService` connects to this same broker to receive uplinks
    // and publish downlinks. It is not a device and has no row in
    // `device_credentials`, so switching authentication on would deny the
    // platform its own broker connection and stop all MQTT ingestion — the
    // classic way this change gets reverted an hour after it ships.
    //
    // It is allowed here, as a superuser so the per-device topic ACL does not
    // apply to it, and only when a password is actually configured. Leaving
    // MQTT_PASSWORD empty does not create a blank-password bypass.
    const platformUser = process.env.MQTT_USERNAME;
    const platformPass = process.env.MQTT_PASSWORD;
    if (
      platformUser &&
      platformPass &&
      username === platformUser &&
      body?.password === platformPass
    ) {
      return { result: 'allow', is_superuser: true };
    }

    // A device may authenticate either with an access token as the username
    // and no password, or with a username/password pair. Both resolve through
    // the same verifier.
    const authed = body?.password
      ? await this.deviceAuth.authenticate({
          kind: 'basic',
          username,
          password: body.password,
        })
      : await this.deviceAuth.authenticate({ kind: 'token', token: username });

    return authed ? { result: 'allow', is_superuser: false } : { result: 'deny' };
  }

  /**
   * EMQX HTTP authorization.
   *
   * A device may only touch its own topic subtree. The deviceKey is resolved
   * from the credential rather than taken from the topic, so a device cannot
   * claim another's identity by publishing to its path.
   */
  @Post('mqtt/authz')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async mqttAuthz(
    @Body()
    body: {
      clientid?: string;
      username?: string;
      topic?: string;
      action?: string;
    },
  ): Promise<{ result: 'allow' | 'deny' }> {
    const username = body?.username ?? body?.clientid;
    const topic = body?.topic;
    if (!username || !topic) return { result: 'deny' };

    const authed = await this.deviceAuth.authenticate({
      kind: 'token',
      token: username,
    });
    if (!authed) return { result: 'deny' };

    const key = authed.device.deviceKey;
    const action = (body.action ?? '').toLowerCase();

    // Publish: only the device's own uplink topics.
    const mayPublish = [
      `devices/${key}/telemetry`,
      `devices/${key}/attributes`,
      `devices/${key}/rpc/response`,
      `devices/${key}/firmware/status`,
    ];

    // Subscribe: only the device's own downlink topics.
    const maySubscribe = [
      `devices/${key}/commands`,
      `devices/${key}/rpc/request`,
      `devices/${key}/attributes/response`,
      `devices/${key}/firmware`,
    ];

    const allowed =
      action === 'publish'
        ? mayPublish.includes(topic)
        : action === 'subscribe'
          ? maySubscribe.includes(topic)
          : false;

    return { result: allowed ? 'allow' : 'deny' };
  }

  /**
   * Operational visibility: is enforcement actually on in this process?
   *
   * `DEVICE_AUTH_ENFORCED` is read once at construction, so an operator
   * cannot tell from the environment alone what a running container decided.
   */
  @Get('status')
  @Public()
  @ApiOperation({ summary: 'Whether device authentication is enforced' })
  status(): { enforced: boolean } {
    return { enforced: this.deviceAuth.isEnforced };
  }
}
