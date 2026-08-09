import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';
import { AlarmsGateway } from './alarms.gateway';
import { Alarm } from './entities/alarm.entity';
import { AlarmsRepository } from './repositories/alarms.repository';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Device, Tenant, User } from '../index.entities';
import { BullModule } from '@nestjs/bull';
import { AlarmConsumer } from './alarms.consumer';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // Escalation timing lives in Redis via Bull, so a delayed check survives a
    // restart. BullModule.forRootAsync() supplies the Redis connection in
    // app.module.ts; this only registers the queue.
    BullModule.registerQueue({ name: 'alarms' }),
    NotificationsModule,
    // User is read-only here — assign() validates the assignee shares the
    // alarm's tenant. Registered as a repository rather than importing
    // UsersModule, which would pull DevicesModule back in through its own
    // forwardRef chain.
    TypeOrmModule.forFeature([Alarm, Device, Tenant, User]),
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION', '7d') as any,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AlarmsController],
  providers: [AlarmsService, AlarmsGateway, AlarmsRepository, AlarmConsumer],
  exports: [AlarmsService, AlarmsGateway],
})
export class AlarmsModule { }
