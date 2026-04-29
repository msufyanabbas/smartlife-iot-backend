// src/modules/devices/codecs/codec.module.ts

import { Module, Global } from '@nestjs/common';
import { CodecRegistryService } from './codec-registry.service';
import { CodecController      } from './codec.controller';

// WS family
import { MilesightWS558Codec  } from './milesight/ws/ws558.codec';
import { MilesightWS101Codec  } from './milesight/ws/ws101.codec';
import { MilesightGS301Codec } from './milesight/gs/gs301.codec';

// EM300 family — base codecs
import { MilesightEM300THCodec  } from './milesight/em/em300-th.codec';
import { MilesightEM300MCSCodec } from './milesight/em/em300-mcs.codec';
import { MilesightEM300SLDCodec } from './milesight/em/em300-sld.codec';
import { MilesightEM300MLDCodec } from './milesight/em/em300-mld.codec';
import { MilesightEM300DICodec  } from './milesight/em/em300-di.codec';
import { MilesightEM300CLCodec  } from './milesight/em/em300-cl.codec';

// AM family — base codecs
import { MilesightAM102Codec  } from './milesight/am/am102.codec';
import { MilesightAM103Codec  } from './milesight/am/am103.codec';
import { MilesightAM104Codec  } from './milesight/am/am104.codec';
import { MilesightAM304LCodec } from './milesight/am/am304l.codec';
import { MilesightAM305LCodec } from './milesight/am/am305l.codec';
import { MilesightAM307Codec  } from './milesight/am/am307.codec';

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
  MilesightWS501CNCodec,
  MilesightWS501Codec,
  MilesightWS501EUCodec,
  MilesightWS501USCodec,
  MilesightWS501V4Codec,
  MilesightWS502CNCodec,
  MilesightWS502Codec,
  MilesightWS502V4Codec,
  MilesightWS503CN_Codec,
  MilesightWS521Codec,
  MilesightWS523Codec,
  MilesightWS525Codec,
  MilesightWS526Codec,
  MilesightWS558_868Codec,
  MilesightWS558_868MCodec,
  MilesightWS558_915Codec,
} from './milesight/ws/ws-variants.codec';
import { MilesightWTS506Codec } from './milesight/wts/wts506.codec';
import { MilesightWT101Codec } from './milesight/wt/wt101.codec';
import { MilesightWT102Codec } from './milesight/wt/wt102.codec';
import { MilesightWT301Codec } from './milesight/wt/wt301.codec';
import { MilesightWT302Codec } from './milesight/wt/wt30x-variants.codec';
import { MilesightWT303Codec } from './milesight/wt/wt303.codec';
import { MilesightWT304Codec } from './milesight/wt/wt304.codec';
import { MilesightWT401Codec } from './milesight/wt/wt401.codec';
import { MilesightVS121Codec } from './milesight/vs/vs121.codec';
import { MilesightVS132Codec } from './milesight/vs/vs132.codec';
import { MilesightVS133Codec, MilesightVS135Codec } from './milesight/vs/vs133.codec';
import { MilesightVS330Codec } from './milesight/vs/vs330.codec';
import { MilesightVS340Codec, MilesightVS341Codec } from './milesight/vs/vs340.codec';
import { MilesightVS350Codec } from './milesight/vs/vs350.codec';
import { MilesightVS351Codec } from './milesight/vs/vs351.codec';
import { MilesightVS360Codec } from './milesight/vs/vs360.codec';
import { MilesightVS321Codec } from './milesight/vs/vs321.codec';
import { MilesightVS370Codec } from './milesight/vs/vs370.codec';
import { MilesightUC100V2Codec } from './milesight/uc/uc100.codec';
import { MilesightUC11N1Codec } from './milesight/uc/uc11-n1.codec';
import { MilesightUC11T1Codec } from './milesight/uc/uc11-t1.codec';
import { MilesightUC300Codec } from './milesight/uc/uc300.codec';
import { MilesightUC300CellularCodec } from './milesight/uc/uc300-cellular.codec';
import { MilesightUC502Codec, MilesightUC50xCodec } from './milesight/uc/uc50x.codec';
import { MilesightUC511Codec, MilesightUC512Codec } from './milesight/uc/uc511.codec';
import { MilesightUC521Codec } from './milesight/uc/uc521.codec';
import { MilesightTS101Codec } from './milesight/ts/ts101.codec';
import { MilesightTS201Codec } from './milesight/ts/ts201.codec';
import { MilesightTS201V2Codec } from './milesight/ts/ts201-v2.codec';
import { MilesightTS301Codec } from './milesight/ts/ts301.codec';
import { MilesightTS301V2Codec } from './milesight/ts/ts301-v2.codec';
import { MilesightTS601Codec } from './milesight/ts/ts601.codec';
import { MilesightTS602Codec } from './milesight/ts/ts602.codec';
import { MilesightGS101Codec } from './milesight/gs/gs101.codec';
import { MilesightGS524NCodec } from './milesight/gs/gs524n.codec';
import { MilesightGS601Codec } from './milesight/gs/gs601.codec';
import { MilesightDS3604Codec } from './milesight/ds/ds3604.codec';
import { MilesightAT101Codec } from './milesight/at/at101.codec';
import { MilesightCT101Codec, MilesightCT103Codec, MilesightCT105Codec } from './milesight/ct/ct101.codec';
import { MilesightCT303Codec, MilesightCT305Codec, MilesightCT310Codec } from './milesight/ct/ct303.codec';
import { MilesightWS52xCodec } from './milesight/ws/ws52x.codec';
import { MilesightWS503V4Codec } from './milesight/ws/ws503v4.codec';
import { MilesightWS503Codec } from './milesight/ws/ws503.codec';
import { MilesightWS502EUCodec } from './milesight/ws/ws502eu.codec';
import { MilesightWS303Codec } from './milesight/ws/ws303.codec';
import { MilesightWS302Codec } from './milesight/ws/ws302.codec';
import { MilesightWS301Codec } from './milesight/ws/ws301.codec';
import { MilesightWS203Codec } from './milesight/ws/ws203.codec';
import { MilesightWS201Codec } from './milesight/ws/ws201.codec';
import { MilesightWS202Codec } from './milesight/ws/ws202.codec';
import { MilesightWS136Codec, MilesightWS156Codec } from './milesight/ws/ws156.codec';
import { MilesightUC100V1Codec } from './milesight/uc/uc100v1.codec';
import { MilesightCTH01Codec } from './milesight/cth/cth01.codec';

const ALL_CODECS = [
  // WS family
  MilesightWS558Codec,
  MilesightWS558_868Codec,
  MilesightWS558_868MCodec,
  MilesightWT301Codec,
  MilesightWT302Codec,
  MilesightWT303Codec,
  MilesightWT304Codec,
  MilesightWT401Codec,
  MilesightWS558_915Codec,
  MilesightWTS506Codec,
  MilesightWS101Codec,
  MilesightWS101SOSCodec,
  MilesightWT101Codec,
  MilesightWT102Codec,
  // EM300 family
  MilesightEM300THCodec,
  MilesightVS121Codec,
  MilesightVS132Codec,
  MilesightVS135Codec,
  MilesightVS133Codec,
  MilesightVS321Codec,
  MilesightVS330Codec,
  MilesightVS340Codec,
  MilesightVS341Codec,
  MilesightVS350Codec,
  MilesightVS351Codec,
  MilesightVS360Codec,
  MilesightVS370Codec,
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

  // UC Series
  MilesightUC100V2Codec,
  MilesightUC100V1Codec,
  MilesightUC11N1Codec,
  MilesightUC11T1Codec,
  MilesightUC300Codec,
  MilesightUC300CellularCodec,
  MilesightUC50xCodec,
  MilesightUC502Codec,
  MilesightUC511Codec,
  MilesightUC512Codec,
  MilesightUC521Codec,

  // CTH Series
  MilesightCTH01Codec,

  // TS Series
  MilesightTS101Codec,
  MilesightTS201Codec,
  MilesightTS201V2Codec,
  MilesightTS301Codec,
  MilesightTS301V2Codec,
  MilesightTS601Codec,
  MilesightTS602Codec,

  // GS Series
  MilesightGS301Codec,
  MilesightGS101Codec,
  MilesightGS524NCodec,
  MilesightGS601Codec,

  // DS Series
  MilesightDS3604Codec,

  // AT Series
  MilesightAT101Codec,

  // CT Series
  MilesightCT101Codec,
  MilesightCT103Codec,
  MilesightCT105Codec,  
  MilesightCT303Codec,
  MilesightCT305Codec,
  MilesightCT310Codec,

  // WS Series
  MilesightWS503V4Codec,
  MilesightWS503Codec,
  MilesightWS503CN_Codec,
  MilesightWS502V4Codec,
  MilesightWS303Codec,
  MilesightWS302Codec,
  MilesightWS136Codec,
  MilesightWS301Codec,
  MilesightWS502EUCodec,
  MilesightWS501Codec,
  MilesightWS203Codec,
  MilesightWS201Codec,
  MilesightWS156Codec,
  MilesightWS202Codec,
  MilesightWS501CNCodec,
  MilesightWS501EUCodec,
  MilesightWS501USCodec,
  MilesightWS501V4Codec,
  MilesightWS502Codec,
  MilesightWS502CNCodec,
  MilesightWS558Codec,
  MilesightWS558_868Codec,
  MilesightWS558_868MCodec,
  MilesightWS558_915Codec,
  MilesightWS101Codec,
  MilesightWS101SOSCodec,
  MilesightWS521Codec,
  MilesightWS523Codec,
  MilesightWS525Codec,
  MilesightWS526Codec,
  MilesightWS52xCodec


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