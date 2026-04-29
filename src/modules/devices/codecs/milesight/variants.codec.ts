// src/modules/devices/codecs/milesight/variants.codec.ts

import { MilesightAM102Codec    } from './am/am102.codec';
import { MilesightAM103Codec    } from './am/am103.codec';
import { MilesightAM104Codec    } from './am/am104.codec';
import { MilesightAM304LCodec   } from './am/am304l.codec';
import { MilesightAM305LCodec   } from './am/am305l.codec';
import { MilesightAM307Codec    } from './am/am307.codec';
import { MilesightEM300SLDCodec } from './em/em300-sld.codec';
import { MilesightEM300DICodec  } from './em/em300-di.codec';
import { MilesightAM308Codec } from './am/am308.codec';
import { MilesightAM319Codec } from './am/am319.codec';
import { MilesightAM319O3Codec } from './am/am319-o3.codec';
import { MilesightEM400MudCodec } from './em/em400-mud.codec';
import { EncodedCommand } from '../interfaces/base-codec.interface';

// ── AM102 family ──────────────────────────────────────────────────────────
export class MilesightAM102ACodec extends MilesightAM102Codec {
  override readonly codecId         = 'milesight-am102a';
  override readonly supportedModels = ['AM102A'];
}
export class MilesightAM102LCodec extends MilesightAM102Codec {
  override readonly codecId         = 'milesight-am102l';
  override readonly supportedModels = ['AM102L'];
}

// ── AM103 family ──────────────────────────────────────────────────────────
export class MilesightAM103LCodec extends MilesightAM103Codec {
  override readonly codecId         = 'milesight-am103l';
  override readonly supportedModels = ['AM103L'];
}

// ── AM104/AM107 family ────────────────────────────────────────────────────
export class MilesightAM107Codec extends MilesightAM104Codec {
  override readonly codecId         = 'milesight-am107';
  override readonly supportedModels = ['AM107'];
}

// ── AM304 family ──────────────────────────────────────────────────────────
export class MilesightAM304Codec extends MilesightAM304LCodec {
  override readonly codecId         = 'milesight-am304';
  override readonly supportedModels = ['AM304'];
}

// ── AM305 family ──────────────────────────────────────────────────────────
export class MilesightAM305Codec extends MilesightAM305LCodec {
  override readonly codecId         = 'milesight-am305';
  override readonly supportedModels = ['AM305'];
}

// ── AM307 family ──────────────────────────────────────────────────────────
export class MilesightAM307LCodec extends MilesightAM307Codec {
  override readonly codecId: string          = 'milesight-am307l';
  override readonly supportedModels: string[] = ['AM307L'];
}

// AM319L = AM319 HCHO (IR) without screen commands (0x2D, 0x3C, 0x66, 0xF0)
export class MilesightAM319LCodec extends MilesightAM319Codec {
  override readonly codecId         = 'milesight-am319l';
  override readonly supportedModels = ['AM319L', 'AM319L-HCHO-IR'];
}

export class MilesightAM319LO3Codec extends MilesightAM319O3Codec {
  override readonly codecId         = 'milesight-am319l-o3';
  override readonly supportedModels = ['AM319L-O3'];
}
export class MilesightAM308LCodec extends MilesightAM308Codec {
  override readonly codecId         = 'milesight-am308l';
  override readonly supportedModels = ['AM308L'];
}

// ── EM300 family ──────────────────────────────────────────────────────────
// ZLD: zone cable leak — identical format to SLD (spot probe)
export class MilesightEM300ZLDCodec extends MilesightEM300SLDCodec {
  override readonly codecId: string          = 'milesight-em300-zld';
  override readonly supportedModels: string[] = ['EM300-ZLD'];
}
// DI-HALL: Hall-effect version of DI pulse counter — identical format
export class MilesightEM300DIHALLCodec extends MilesightEM300DICodec {
  override readonly codecId: string          = 'milesight-em300-di-hall';
  override readonly supportedModels: string[] = ['EM300-DI-HALL'];
}

export class MilesightEM400TldCodec extends MilesightEM400MudCodec {
  override readonly codecId         = 'milesight-em400-tld';
  override readonly supportedModels = ['EM400-TLD'];

  // EM400-TLD has no 'parking' working mode and a tighter install_height range
  override encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    if (type === 'set_working_mode') {
      const mode = typeof p.working_mode === 'string' ? p.working_mode : ['standard','bin','parking'][p.working_mode ?? 0];
      if (mode === 'parking') throw new Error('EM400-TLD does not support parking working mode');
    }
    if (type === 'set_install_height') {
      const v = p.install_height ?? p.mm ?? 1000;
      if (v < 20 || v > 3500) throw new Error('EM400-TLD install_height: 20–3500 mm');
    }
    return super.encode(command);
  }
}

export class MilesightEM400UdlCodec extends MilesightEM400MudCodec {
  override readonly codecId         = 'milesight-em400-udl';
  override readonly supportedModels = ['EM400-UDL'];

  override encode(command: { type: string; params?: any }): EncodedCommand {
    const { type } = command;
    if (type === 'set_install_height') throw new Error('EM400-UDL does not support install_height');
    if (type === 'set_bin_mode_alarm') throw new Error('EM400-UDL does not support bin mode alarm');
    if (type === 'set_working_mode') {
      const mode = typeof command.params?.working_mode === 'string'
        ? command.params.working_mode
        : ['standard','bin','parking'][command.params?.working_mode ?? 0];
      if (mode !== 'standard') throw new Error('EM400-UDL only supports standard working mode');
    }
    return super.encode(command);
  }
}