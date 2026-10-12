import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Converter } from './entities/converter.entity';
import { Device } from '../devices/entities/device.entity';
import { ConvertersController } from './converters.controller';
import { ConvertersService } from './converters.service';
import { ConverterExecutionService } from './converter-execution.service';

/**
 * ConvertersModule.
 *
 * `Device` is registered through `TypeOrmModule.forFeature` rather than by
 * importing `DevicesModule`, which is the established way here (see the
 * floor-plans note in CLAUDE.md §4a): `convertForDevice()` needs one read of
 * the devices table and importing the module both ways is how a circular
 * dependency starts.
 *
 * `CodecRegistryService` needs no import at all — `CodecModule` is `@Global()`,
 * so the registry (and the 80+ codecs registered into it at boot) is injectable
 * from here directly. That is deliberate: the `codec` converter type delegates
 * to it and reimplements no decoding.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Converter, Device])],
  controllers: [ConvertersController],
  providers: [ConvertersService, ConverterExecutionService],
  exports: [ConvertersService, ConverterExecutionService],
})
export class ConvertersModule {}
