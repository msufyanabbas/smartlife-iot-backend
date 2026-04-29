// src/modules/devices/codecs/milesight/ws-variants.codec.ts
// Thin variant subclasses for all Milesight WS series models.
// Each class overrides only codecId and supportedModels.
// All protocol logic lives in the base codec file.

import { MilesightWS101Codec } from './ws101.codec';
import { MilesightWS502EUCodec } from './ws502eu.codec';
import { MilesightWS503CNCodec } from './ws503cn.codec';
import { MilesightWS503Codec } from './ws503.codec';
import { MilesightWS503V4Codec } from './ws503v4.codec';
import { MilesightWS51xCodec } from './ws51x.codec';
import { MilesightWS52xCodec } from './ws52x.codec';
import { MilesightWS558Codec } from './ws558.codec';

// ── WS50x variants ────────────────────────────────────────────────────────────
// WS501 — 1-gang smart wall switch
// WS502 — 2-gang smart wall switch
// WS503 — 3-gang smart wall switch
// All share identical wire protocol — base class covers all three.

export class MilesightWS501Codec extends MilesightWS503Codec {
  override readonly codecId         = 'milesight-ws501';
  override readonly supportedModels = ['WS501'];
}

export class MilesightWS502Codec extends MilesightWS503Codec {
  override readonly codecId         = 'milesight-ws502';
  override readonly supportedModels = ['WS502'];
}

// WS502-EU — EU 868 MHz, 2-gang, has power metering + CN-style switch channel
// MUST be listed before WS503-CN in ALL_CODECS (canDecode requires both 0x08 0x29 AND power channels)
export class MilesightWS502EU_Codec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws502-eu';
  override readonly supportedModels = ['WS502-EU'];
}

// WS501-EU / WS501-US — 1-gang variants of WS502-EU.
// Identical wire protocol; only 1 switch. switch_2 simply absent.
export class MilesightWS501EUCodec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws501-eu';
  override readonly supportedModels = ['WS501-EU'];
}

export class MilesightWS501USCodec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws501-us';
  override readonly supportedModels = ['WS501-US'];
}

// WS503-CN — China 470 MHz band, different protocol from standard WS503
// (0x08 0x29 switch channel, rule_config, 0xF9 0xBD timezone)
export class MilesightWS503CN_Codec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws503-cn';
  override readonly supportedModels = ['WS503-CN'];
}

// WS501-CN / WS502-CN if needed:
export class MilesightWS501CNCodec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws501-cn';
  override readonly supportedModels = ['WS501-CN'];
}

export class MilesightWS502CNCodec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws502-cn';
  override readonly supportedModels = ['WS502-CN'];
}

// WS502-V4 — 2-gang variant of WS503 v4 advanced firmware.
// Identical wire protocol to WS503 v4; only 2 buttons/switches.
// power_consumption_2w encodes 2 powers (not 3); decoder reads the same channels
// and gracefully handles button3 as absent/zero.
export class MilesightWS502V4Codec extends MilesightWS503V4Codec {
  override readonly codecId         = 'milesight-ws502-v4';
  override readonly supportedModels = ['WS502-V4'];
}

// WS501-V4 — 1-gang variant of WS503 v4 advanced firmware.
// Identical wire protocol to WS503 v4; only 1 button/switch.
// power_consumption_2w encodes 1 power (button_power1 only).
export class MilesightWS501V4Codec extends MilesightWS503V4Codec {
  override readonly codecId         = 'milesight-ws501-v4';
  override readonly supportedModels = ['WS501-V4'];
}

// ── WS51x variants ────────────────────────────────────────────────────────────
// WS515 — EU 868 MHz wall socket
// WS516 — US 915 MHz wall socket
// WS517 — AU 915 MHz wall socket
// All share identical wire protocol — base class covers these models.

export class MilesightWS513Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws513';
  override readonly supportedModels = ['WS513'];
}

export class MilesightWS515Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws515';
  override readonly supportedModels = ['WS515'];
}

export class MilesightWS516Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws516';
  override readonly supportedModels = ['WS516'];
}

export class MilesightWS517Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws517';
  override readonly supportedModels = ['WS517'];
}

// ── WS101 variants ────────────────────────────────────────────────────────────

// WS101-SOS — SOS/emergency button variant; identical protocol to WS101
export class MilesightWS101SOSCodec extends MilesightWS101Codec {
  override readonly codecId         = 'milesight-ws101-sos';
  override readonly supportedModels = ['WS101-SOS'];
}

// ── WS52x variants ────────────────────────────────────────────────────────────
// WS521 — EU 868 MHz compact socket
// WS523 — EU 868 MHz socket with child lock
// WS525 — CN 470 MHz socket
// WS526 — AU 915 MHz socket
// All share identical wire protocol — base class already covers these models.
// Per-model subclasses added below for explicit module registration.

export class MilesightWS521Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws521';
  override readonly supportedModels = ['WS521'];
}

export class MilesightWS523Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws523';
  override readonly supportedModels = ['WS523'];
}

export class MilesightWS525Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws525';
  override readonly supportedModels = ['WS525'];
}

export class MilesightWS526Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws526';
  override readonly supportedModels = ['WS526'];
}

// ── WS558 variants ────────────────────────────────────────────────────────────

// WS558-868 — EU 868 MHz 8-switch controller
export class MilesightWS558_868Codec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-868';
  override readonly supportedModels = ['WS558-868'];
}

// WS558-868M — 868 MHz EU band, metal enclosure variant
export class MilesightWS558_868MCodec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-868m';
  override readonly supportedModels = ['WS558-868M'];
}

// WS558-915 — US/AU 915 MHz 8-switch controller
export class MilesightWS558_915Codec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-915';
  override readonly supportedModels = ['WS558-915'];
}