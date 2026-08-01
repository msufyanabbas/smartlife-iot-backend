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

@Module({
  imports: [
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
  providers: [AlarmsService, AlarmsGateway, AlarmsRepository],
  exports: [AlarmsService, AlarmsGateway],
})
export class AlarmsModule { }
