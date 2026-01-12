import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesController } from './profiles.controller';
import { DeviceProfilesService } from '../profiles/device-profiles.service';
import { AssetProfilesService } from '../profiles/asset-profiles.service';
import { DeviceProfile } from './entities/device-profile.entity';
import { AssetProfile } from './entities/asset-profile.entity';
import { Device } from '../devices/entities/device.entity';
import { Asset } from '../assets/entities/asset.entity';
import { AssetProfilesController } from './asset-profile.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceProfile, AssetProfile, Device, Asset]),
  ],
  controllers: [ProfilesController, AssetProfilesController],
  providers: [DeviceProfilesService, AssetProfilesService],
  exports: [DeviceProfilesService, AssetProfilesService],
})
export class ProfilesModule {}
