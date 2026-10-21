/**
 * Carries WsSubscriptionAuthorizer to the three gateways that need it.
 *
 * It deliberately imports no feature module — only the Device repository.
 * WebsocketModule, AlarmsModule and TelemetryModule already import each other
 * in a knot held together by forwardRef(); a shared provider that pulled in
 * DevicesModule would tighten that knot until Nest could not resolve it. A
 * repository-only module can be imported from anywhere.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Device } from '@modules/devices/entities/device.entity';

import { WsSubscriptionAuthorizer } from './ws-subscription-authorizer';

@Module({
  imports: [
    TypeOrmModule.forFeature([Device]),
    // ── Why JwtModule is here ─────────────────────────────────────────────
    //
    // A socket gateway needs two things to decide a subscription: WsJwtGuard
    // (who is this) and WsSubscriptionAuthorizer (what may they watch). The
    // guard injects JwtService, and Nest resolves a guard in the DI context
    // of the module that declares the gateway using it.
    //
    // TelemetryGateway was dead code — in no module's `providers`, so Nest
    // never instantiated it and never resolved its guard. Registering it in
    // TelemetryModule made the gateway real and the missing JwtService fatal:
    //
    //   Nest can't resolve dependencies of the WsJwtGuard (?, ConfigService).
    //   Please make sure that the argument JwtService at index [0] is
    //   available in the TelemetryModule context.
    //
    // The application would not boot at all. Nothing caught it: `tsc` cannot
    // see a DI graph, and `check:swagger` builds a probe module rather than
    // the real AppModule. Only running `node dist/main.js` found it — hence
    // `check:boot`.
    //
    // Exported from here rather than pasted into TelemetryModule because this
    // module is already "what every socket gateway needs in order to
    // authorize", and a third copy of the same registerAsync block is a third
    // place for the secret configuration to drift.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION', '7d') as any,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [WsSubscriptionAuthorizer],
  // JwtModule is re-exported so an importer's gateways can resolve WsJwtGuard.
  exports: [WsSubscriptionAuthorizer, JwtModule],
})
export class WsAuthorizationModule {}
