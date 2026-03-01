import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttributesService } from './attributes.service';
import { AttributesController } from './attributes.controller';
import { Attribute } from './entities/attribute.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Asset } from '@modules/assets/entities/asset.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Attribute, Device, Asset])],
  controllers: [AttributesController],
  providers: [AttributesService],
  exports: [AttributesService],
})
export class AttributesModule { }
