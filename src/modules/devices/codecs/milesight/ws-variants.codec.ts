// src/modules/devices/codecs/milesight/ws-variants.codec.ts

import { MilesightWS558Codec } from './ws558.codec';
import { MilesightWS101Codec } from './ws101.codec';

export class MilesightWS558_868Codec extends MilesightWS558Codec {
  override readonly codecId: string          = 'milesight-ws558-868';
  override readonly supportedModels: string[] = ['WS558-868'];
}

// WS558-868M — 868 MHz EU band, metal enclosure (M) variant
// Identical LoRaWAN protocol and payload format to WS558-868.
export class MilesightWS558_868MCodec extends MilesightWS558Codec {
  override readonly codecId: string          = 'milesight-ws558-868m';
  override readonly supportedModels: string[] = ['WS558-868M'];
}

export class MilesightWS558_915Codec extends MilesightWS558Codec {
  override readonly codecId: string          = 'milesight-ws558-915';
  override readonly supportedModels: string[] = ['WS558-915'];
}

export class MilesightWS101SOSCodec extends MilesightWS101Codec {
  override readonly codecId: string          = 'milesight-ws101-sos';
  override readonly supportedModels: string[] = ['WS101-SOS'];
}