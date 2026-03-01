import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';
import { AlarmsGateway } from './alarms.gateway';
import { Alarm } from './entities/alarm.entity';
import { AlarmsRepository } from './repositories/alarms.repository';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Device, Tenant } from '../index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alarm, Device, Tenant]),
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
