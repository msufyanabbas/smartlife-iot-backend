// src/modules/devices/codecs/milesight/variants.codec.ts

import { MilesightAM102Codec    } from './am102.codec';
import { MilesightAM103Codec    } from './am103.codec';
import { MilesightAM104Codec    } from './am104.codec';
import { MilesightAM304LCodec   } from './am304l.codec';
import { MilesightAM305LCodec   } from './am305l.codec';
import { MilesightAM307Codec    } from './am307.codec';
import { MilesightEM300SLDCodec } from './em300/em300-sld.codec';
import { MilesightEM300DICodec  } from './em300/em300-di.codec';

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