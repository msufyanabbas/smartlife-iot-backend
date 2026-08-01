import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { DeviceCredentialsService } from './device-credentials.service';
import { Device } from './entities/device.entity';
import { DeviceCredentials } from './entities/device-credentials.entity';
import { Asset } from '../assets/entities/asset.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ProtocolsModule } from '../protocols/protocols.module';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { RolesModule } from '@modules/roles/roles.module';
import { CodecModule } from './codecs/codec.module';
import { DeviceProfile } from '../profiles/entities/device-profile.entity';
import { ProfilesModule } from '../profiles/profiles.module';


@Module({
  imports: [
    // Asset is registered as a repository rather than by importing AssetsModule,
    // to keep device↔asset validation from creating a module cycle.
    TypeOrmModule.forFeature([Device, DeviceCredentials, Asset, DeviceProfile]),
    // ProfilesModule exports ProfileAlarmService, used to materialise a
    // profile's alarm rules when a device is created against it.
    ProfilesModule,
    SubscriptionsModule,
    RolesModule,
    ProtocolsModule,
    CodecModule,
    // UsersModule was listed twice — once wrapped in forwardRef and once
    // directly. The redundant plain entry is dropped; the forwardRef is the one
    // that matters, since UsersModule imports DevicesModule back.
    forwardRef(() => UsersModule),
    MailModule,
  ],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceCredentialsService],
  exports: [DevicesService, DeviceCredentialsService],
})
export class DevicesModule {}