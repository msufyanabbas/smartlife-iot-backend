import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesController } from './device-profile.controller';
import { DeviceProfilesService } from '../profiles/device-profiles.service';
import { AssetProfilesService } from '../profiles/asset-profiles.service';
import { ProfileAlarmService } from './profile-alarm.service';
import { DeviceProfile } from './entities/device-profile.entity';
import { AssetProfile } from './entities/asset-profile.entity';
import { Device } from '../devices/entities/device.entity';
import { Asset } from '../assets/entities/asset.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { AssetProfilesController } from './asset-profile.controller';

// The Alarm repository is registered directly rather than importing
// AlarmsModule: ProfileAlarmService only needs to read/write alarm rows and
// AlarmsModule already depends on the Device repository, so importing it in
// this direction risks a cycle once TelemetryModule pulls ProfilesModule in.
@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceProfile, AssetProfile, Device, Asset, Alarm]),
  ],
  controllers: [ProfilesController, AssetProfilesController],
  providers: [DeviceProfilesService, AssetProfilesService, ProfileAlarmService],
  exports: [DeviceProfilesService, AssetProfilesService, ProfileAlarmService],
})
export class ProfilesModule {}
