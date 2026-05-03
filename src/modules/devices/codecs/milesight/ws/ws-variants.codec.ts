// src/modules/devices/codecs/milesight/ws-variants.codec.ts
// Thin variant subclasses for all Milesight WS series models.
// Each class overrides codecId, supportedModels, and getCapabilities() where needed.
// All protocol logic lives in the base codec file.

import { MilesightWS101Codec } from './ws101.codec';
import { MilesightWS502EUCodec } from './ws502eu.codec';
import { MilesightWS503CNCodec } from './ws503cn.codec';
import { MilesightWS503Codec } from './ws503.codec';
import { MilesightWS503V4Codec } from './ws503v4.codec';
import { MilesightWS51xCodec } from './ws51x.codec';
import { MilesightWS52xCodec } from './ws52x.codec';
import { MilesightWS558Codec } from './ws558.codec';
import { DeviceCapability } from '@/common/interfaces/device-capability.interface';

// ── WS50x variants ────────────────────────────────────────────────────────────

// WS501 — 1-gang smart wall switch
export class MilesightWS501Codec extends MilesightWS503Codec {
  override readonly codecId         = 'milesight-ws501';
  override readonly supportedModels = ['WS501'];

  override getCapabilities(): DeviceCapability {
    return {
      ...super.getCapabilities(),
      codecId:     this.codecId,
      model:       'WS501',
      description: 'Smart Wall Switch (1-gang) — switch control, child lock, delay tasks',
    };
  }
}

// WS502 — 2-gang smart wall switch
export class MilesightWS502Codec extends MilesightWS503Codec {
  override readonly codecId         = 'milesight-ws502';
  override readonly supportedModels = ['WS502'];

  override getCapabilities(): DeviceCapability {
    return {
      ...super.getCapabilities(),
      codecId:     this.codecId,
      model:       'WS502',
      description: 'Smart Wall Switch (2-gang) — switch control, child lock, delay tasks',
    };
  }
}

// WS502-EU — EU 868 MHz, 2-gang, has power metering + CN-style switch channel
// MUST be listed before WS503-CN in ALL_CODECS
export class MilesightWS502EU_Codec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws502-eu';
  override readonly supportedModels = ['WS502-EU'];

  override getCapabilities(): DeviceCapability {
    return {
      ...super.getCapabilities(),
      codecId:     this.codecId,
      model:       'WS502-EU',
      description: 'Smart Wall Switch (2-gang, EU 868 MHz) — power metering, delay tasks',
    };
  }
}

// WS501-EU — 1-gang variant of WS502-EU (switch_2 simply absent in payloads)
export class MilesightWS501EUCodec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws501-eu';
  override readonly supportedModels = ['WS501-EU'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS501-EU',
      description:  'Smart Wall Switch (1-gang, EU 868 MHz) — power metering',
      // Only expose switch_1 telemetry key
      telemetryKeys: base.telemetryKeys.filter(k => k.key !== 'switch_2'),
      uiComponents:  base.uiComponents.filter(c => !c.keys.includes('switch_2')),
    };
  }
}

// WS501-US — same as WS501-EU but for US 915 MHz band
export class MilesightWS501USCodec extends MilesightWS502EUCodec {
  override readonly codecId         = 'milesight-ws501-us';
  override readonly supportedModels = ['WS501-US'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS501-US',
      description:  'Smart Wall Switch (1-gang, US 915 MHz) — power metering',
      telemetryKeys: base.telemetryKeys.filter(k => k.key !== 'switch_2'),
      uiComponents:  base.uiComponents.filter(c => !c.keys.includes('switch_2')),
    };
  }
}

// WS503-CN — China 470 MHz band, rule engine, 0xF9 0xBD timezone
export class MilesightWS503CN_Codec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws503-cn';
  override readonly supportedModels = ['WS503-CN'];

  override getCapabilities(): DeviceCapability {
    return {
      ...super.getCapabilities(),
      codecId:     this.codecId,
      model:       'WS503-CN',
      description: 'Smart Wall Switch (3-gang, CN 470 MHz) — rule engine, timezone support',
    };
  }
}

// WS502-CN — 2-gang CN variant (switch_3 simply absent in payloads)
export class MilesightWS502CNCodec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws502-cn';
  override readonly supportedModels = ['WS502-CN'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS502-CN',
      description:  'Smart Wall Switch (2-gang, CN 470 MHz) — rule engine, timezone support',
      telemetryKeys: base.telemetryKeys.filter(k => k.key !== 'switch_3'),
      uiComponents:  base.uiComponents.filter(c => !c.keys.includes('switch_3')),
    };
  }
}

// WS501-CN — 1-gang CN variant
export class MilesightWS501CNCodec extends MilesightWS503CNCodec {
  override readonly codecId         = 'milesight-ws501-cn';
  override readonly supportedModels = ['WS501-CN'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS501-CN',
      description:  'Smart Wall Switch (1-gang, CN 470 MHz) — rule engine, timezone support',
      telemetryKeys: base.telemetryKeys.filter(k => k.key !== 'switch_2' && k.key !== 'switch_3'),
      uiComponents:  base.uiComponents.filter(c => !c.keys.includes('switch_2') && !c.keys.includes('switch_3')),
    };
  }
}

// WS503-V4 — 3-gang, advanced firmware (already defined in ws503v4.codec.ts)
// Thin alias only — base class already returns the correct model name.

// WS502-V4 — 2-gang variant of WS503 v4 (button3 absent in payloads)
export class MilesightWS502V4Codec extends MilesightWS503V4Codec {
  override readonly codecId         = 'milesight-ws502-v4';
  override readonly supportedModels = ['WS502-V4'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS502-V4',
      description:  'Smart Wall Switch (2-gang, v4) — power metering, scheduling, D2D, DST',
      telemetryKeys: base.telemetryKeys.filter(k => k.key !== 'button_status.button3'),
      uiComponents:  base.uiComponents.filter(c => !c.keys.includes('button_status.button3')),
    };
  }
}

// WS501-V4 — 1-gang variant of WS503 v4
export class MilesightWS501V4Codec extends MilesightWS503V4Codec {
  override readonly codecId         = 'milesight-ws501-v4';
  override readonly supportedModels = ['WS501-V4'];

  override getCapabilities(): DeviceCapability {
    const base = super.getCapabilities();
    return {
      ...base,
      codecId:      this.codecId,
      model:        'WS501-V4',
      description:  'Smart Wall Switch (1-gang, v4) — power metering, scheduling, D2D, DST',
      telemetryKeys: base.telemetryKeys.filter(
        k => k.key !== 'button_status.button2' && k.key !== 'button_status.button3',
      ),
      uiComponents: base.uiComponents.filter(
        c => !c.keys.includes('button_status.button2') && !c.keys.includes('button_status.button3'),
      ),
    };
  }
}

// ── WS51x variants ────────────────────────────────────────────────────────────
// All share identical wire protocol; only region/band differs.

export class MilesightWS513Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws513';
  override readonly supportedModels = ['WS513'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS513' };
  }
}

export class MilesightWS515Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws515';
  override readonly supportedModels = ['WS515'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS515' };
  }
}

export class MilesightWS516Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws516';
  override readonly supportedModels = ['WS516'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS516' };
  }
}

export class MilesightWS517Codec extends MilesightWS51xCodec {
  override readonly codecId         = 'milesight-ws517';
  override readonly supportedModels = ['WS517'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS517' };
  }
}

// ── WS101 variants ────────────────────────────────────────────────────────────

// WS101-SOS — SOS/emergency button; same protocol as WS101
export class MilesightWS101SOSCodec extends MilesightWS101Codec {
  override readonly codecId         = 'milesight-ws101-sos';
  override readonly supportedModels = ['WS101-SOS'];

  override getCapabilities(): DeviceCapability {
    return {
      ...super.getCapabilities(),
      codecId:     this.codecId,
      model:       'WS101-SOS',
      description: 'SOS/Emergency Button — short press, long press, double press events',
    };
  }
}

// ── WS52x variants ────────────────────────────────────────────────────────────
// All share identical wire protocol; only region/band differs.

export class MilesightWS521Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws521';
  override readonly supportedModels = ['WS521'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS521' };
  }
}

export class MilesightWS523Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws523';
  override readonly supportedModels = ['WS523'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS523' };
  }
}

export class MilesightWS525Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws525';
  override readonly supportedModels = ['WS525'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS525' };
  }
}

export class MilesightWS526Codec extends MilesightWS52xCodec {
  override readonly codecId         = 'milesight-ws526';
  override readonly supportedModels = ['WS526'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS526' };
  }
}

// ── WS558 variants ────────────────────────────────────────────────────────────
// All share identical wire protocol; only region/band differs.

// WS558-868 — EU 868 MHz 8-switch controller
export class MilesightWS558_868Codec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-868';
  override readonly supportedModels = ['WS558-868'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS558-868' };
  }
}

// WS558-868M — 868 MHz EU band, metal enclosure variant
export class MilesightWS558_868MCodec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-868m';
  override readonly supportedModels = ['WS558-868M'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS558-868M' };
  }
}

// WS558-915 — US/AU 915 MHz 8-switch controller
export class MilesightWS558_915Codec extends MilesightWS558Codec {
  override readonly codecId         = 'milesight-ws558-915';
  override readonly supportedModels = ['WS558-915'];

  override getCapabilities(): DeviceCapability {
    return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS558-915' };
  }
}