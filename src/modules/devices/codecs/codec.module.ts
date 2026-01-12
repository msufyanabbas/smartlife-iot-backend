// src/modules/devices/codecs/codec.module.ts
/**
 * Codec Module
 * Provides device encoding/decoding services
 */

import { Module, Global } from '@nestjs/common';
import { CodecRegistryService } from './codec-registry.service';

// Import all codec implementations
import { MilesightWS558Codec } from './milesight/ws558.codec';
import { MilesightEM300Codec } from './milesight/em300.codec';
import { GenericMqttJsonCodec } from './generic/mqtt-json.codec';
import { CodecController } from './codec.controller';

@Global() // Make available everywhere
@Module({
  providers: [
    CodecRegistryService,
    
    // Register all codecs as providers
    MilesightWS558Codec,
    MilesightEM300Codec,
    GenericMqttJsonCodec,
    
    // Factory to auto-register codecs on startup
    {
      provide: 'CODEC_INITIALIZER',
      useFactory: (
        registry: CodecRegistryService,
        ws558: MilesightWS558Codec,
        em300: MilesightEM300Codec,
        mqttJson: GenericMqttJsonCodec,
      ) => {
        // Auto-register all codecs
        registry.registerCodec(ws558);
        registry.registerCodec(em300);
        registry.registerCodec(mqttJson);
        
        return registry;
      },
      inject: [
        CodecRegistryService,
        MilesightWS558Codec,
        MilesightEM300Codec,
        GenericMqttJsonCodec,
      ],
    },
  ],
  controllers: [CodecController],
  exports: [CodecRegistryService],
})
export class CodecModule {}