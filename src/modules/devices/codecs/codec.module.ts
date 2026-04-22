// src/modules/devices/codecs/codec.module.ts

import { Module, Global } from '@nestjs/common';
import { CodecRegistryService } from './codec-registry.service';
import { CodecController      } from './codec.controller';

// WS family
import { MilesightWS558Codec  } from './milesight/ws558.codec';
import { MilesightWS101Codec  } from './milesight/ws101.codec';

// EM300 family — base codecs
import { MilesightEM300THCodec  } from './milesight/em300/em300-th.codec';
import { MilesightEM300MCSCodec } from './milesight/em300/em300-mcs.codec';
import { MilesightEM300SLDCodec } from './milesight/em300/em300-sld.codec';
import { MilesightEM300MLDCodec } from './milesight/em300/em300-mld.codec';
import { MilesightEM300DICodec  } from './milesight/em300/em300-di.codec';
import { MilesightEM300CLCodec  } from './milesight/em300/em300-cl.codec';

// AM family — base codecs
import { MilesightAM102Codec  } from './milesight/am102.codec';
import { MilesightAM103Codec  } from './milesight/am103.codec';
import { MilesightAM104Codec  } from './milesight/am104.codec';
import { MilesightAM304LCodec } from './milesight/am304l.codec';
import { MilesightAM305LCodec } from './milesight/am305l.codec';
import { MilesightAM307Codec  } from './milesight/am307.codec';

import { GenericMqttJsonCodec } from './generic/mqtt-json.codec';

// Thin variants
import {
  MilesightAM102ACodec,
  MilesightAM102LCodec,
  MilesightAM103LCodec,
  MilesightAM107Codec,
  MilesightAM304Codec,
  MilesightAM305Codec,
  MilesightAM307LCodec,
  MilesightEM300ZLDCodec,
  MilesightEM300DIHALLCodec,
} from './milesight/variants.codec';

import {
  MilesightWS101SOSCodec,
  MilesightWS558_868Codec,
  MilesightWS558_868MCodec,
  MilesightWS558_915Codec,
} from './milesight/ws-variants.codec';

const ALL_CODECS = [
  // WS family
  MilesightWS558Codec,
  MilesightWS558_868Codec,
  MilesightWS558_868MCodec,
  MilesightWS558_915Codec,
  MilesightWS101Codec,
  MilesightWS101SOSCodec,
  // EM300 family
  MilesightEM300THCodec,
  MilesightEM300MCSCodec,
  MilesightEM300SLDCodec,
  MilesightEM300ZLDCodec,
  MilesightEM300MLDCodec,
  MilesightEM300DICodec,
  MilesightEM300DIHALLCodec,
  MilesightEM300CLCodec,
  // AM family
  MilesightAM102Codec,
  MilesightAM102ACodec,
  MilesightAM102LCodec,
  MilesightAM103Codec,
  MilesightAM103LCodec,
  MilesightAM104Codec,
  MilesightAM107Codec,
  MilesightAM304LCodec,
  MilesightAM304Codec,
  MilesightAM305LCodec,
  MilesightAM305Codec,
  MilesightAM307Codec,
  MilesightAM307LCodec,
  // Generic
  GenericMqttJsonCodec,
];

@Global()
@Module({
  providers: [
    CodecRegistryService,
    ...ALL_CODECS,
    {
      provide: 'CODEC_INITIALIZER',
      useFactory: (registry: CodecRegistryService, ...codecs: any[]) => {
        codecs.forEach(c => registry.registerCodec(c));
        return registry;
      },
      inject: [CodecRegistryService, ...ALL_CODECS],
    },
  ],
  controllers: [CodecController],
  exports: [CodecRegistryService],
})
export class CodecModule {}