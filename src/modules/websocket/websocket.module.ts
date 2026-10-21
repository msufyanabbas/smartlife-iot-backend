import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebsocketGateway } from './websocket.gateway';
import { WsAuthorizationModule } from '@common/websocket/ws-authorization.module';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';

@Module({
  imports: [
    // Repositories only — importing DashboardsModule or TelemetryModule here
    // would be a cycle, since both of those import WebsocketModule.
    TypeOrmModule.forFeature([Dashboard, Telemetry]),
    // Supplies WsSubscriptionAuthorizer. Depends on no feature module, so it
    // is safe to import from inside the gateway cycle.
    WsAuthorizationModule,
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
  providers: [WebsocketGateway],
  exports: [WebsocketGateway],
})
export class WebsocketModule {}