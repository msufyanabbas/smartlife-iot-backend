// src/modules/devices/codecs/milesight/ds3604.codec.ts
// Milesight DS3604 — LoRaWAN Smart E-Ink Display
//
// Protocol: IPSO channel_id + channel_type, with two proprietary channel families:
//   0xFB xx — template content / config / image data (multi-byte structured payloads)
//   0xFA xx — operation result acknowledgements
//
// ── Standard attributes (0xFF channel) ─────────────────────────────────────
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B hex)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x01 0x75 — battery (uint8, %)
//   0xFF 0x2E — button_status (0=single_click, 1=double_click, 2=short_press, 3=long_press)
//   0xFF 0x73 — current_template_id (stored 0-indexed, reported 1-indexed)
//
// ── Template content (0xFB 0x01) ─────────────────────────────────────────────
//   Frame: <id_byte:1B> <length:1B> <utf8_data:NB>
//   id_byte: bits[7:6] = template_id (0=template_1, 1=template_2)
//            bits[5:0] = block_id (0-9=text_1..text_10, 10=qrcode)
//   → decoded.template_1.text_1 = "...", decoded.template_1.qrcode = "..."
//
// ── Image data (0xFB 0x02) ────────────────────────────────────────────────────
//   Not decoded (binary image payload, not implemented)
//
// ── Template config (0xFB 0x03) ──────────────────────────────────────────────
//   Frame: <id_byte:1B> <length:1B> <config_struct:NB>
//   block_id 0-9   → text block config (21B basic + 4B font = 25B total)
//   block_id 10    → qrcode block config (21B + 1B codec = 22B total)
//   block_id 11-12 → image block config  (21B + 1B algo = 22B total)
//   block_id 13-14 → battery/connect status block config (21B)
//   Basic config struct (21B):
//     enable(1B) + type(1B) + start_x(2B) + start_y(2B) + end_x(2B) + end_y(2B)
//     + border(1B) + horizontal(1B) + vertical(1B) + background(1B) + foreground(1B)
//     + reserved(1B) + layer(1B) + reserved(4B)
//   Font extension (4B, text blocks only):
//     font_type(1B) + font_size(1B) + wrap(1B) + font_style(1B)
//
// ── Operation results ────────────────────────────────────────────────────────
//   0xFA 0x01 — update_content_result[] (id_byte + result_byte)
//   0xFA 0x02 — receive_image_data_result[] (id_byte + data_frame_byte)
//   0xFA 0x03 — update_template_result[] (id_byte + result_byte)
//
// ── Downlink responses (0xFF / 0xFE channel) ─────────────────────────────────
//   0xFF 0x03 — report_interval (uint16 LE, seconds)
//   0xFF 0x10 — reboot echo
//   0xFF 0x25 — button_enable
//   0xFF 0x27 — clear_image echo
//   0xFF 0x28 — report_* echo (sub-byte: 0x00=battery, 0x01=buzzer, 0x02=template, 0x03=display)
//   0xFF 0x3D — beep/refresh echo (sub-byte: 0x01=beep, 0x02=refresh)
//   0xFF 0x3E — buzzer_enable
//   0xFF 0x66 — button_visible
//   0xFF 0x73 — current_template_id (0-indexed → 1-indexed)
//   0xFF 0x82 — multicast_config
//   0xFF 0x89 — block_visible (masked uint16 + data uint16)
//   0xFF 0x90 — switch_template_button_enable
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0xFB 0x01 <id> <len> <utf8>   — set text/qrcode content for template
//   0xFF 0x73 <id>                — change current template (0-indexed)
//   0xFF 0x03 <u16>               — set report interval (seconds)
//   0xFF 0x10 0xFF                — reboot
//   0xFF 0x3D 0x01                — beep
//   0xFF 0x3D 0x02                — refresh display
//   0xFF 0x28 0x00..0x03          — report battery/buzzer/template/display
//   0xFF 0x3E <en>                — buzzer enable
//   0xFF 0x66 <vis>               — button visible
//   0xFF 0x25 <en>                — button enable
//   0xFF 0x89 0x02 <masked_u16> <data_u16> — block visible
//   0xFF 0x27 <data>              — clear images
//   0xFF 0x90 <en>                — switch template button enable
//   0xFF 0x82 <data>              — multicast config
//   0xFB 0x03 <id> <len> <struct> — set template block config
//
// ── canDecode fingerprint ────────────────────────────────────────────────────
//   0x01 0x75 (battery with unique type) — very distinctive
//   0xFF 0x2E (button_status)            — DS3604-exclusive
//   0xFF 0x73 (current_template_id)      — DS3604-exclusive
//   0xFB 0x01/0x02/0x03                  — template channels, DS3604-exclusive

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

function decodeUtf8(bytes: number[]): string {
  let str = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 <= 0x7f) {
      str += String.fromCharCode(b1);
    } else if (b1 <= 0xdf) {
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b1 <= 0xef) {
      const b2 = bytes[i++]; const b3 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++]; const b3 = bytes[i++]; const b4 = bytes[i++];
      const cp = (((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)) - 0x10000;
      str += String.fromCharCode((cp >> 10) + 0xd800, (cp & 0x3ff) + 0xdc00);
    }
  }
  return str;
}

function encodeUtf8(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) { bytes.push(c); }
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0x10000) { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else { bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return bytes;
}

const BLOCK_NAMES: Record<number, string> = {
  0:'text_1', 1:'text_2', 2:'text_3', 3:'text_4', 4:'text_5',
  5:'text_6', 6:'text_7', 7:'text_8', 8:'text_9', 9:'text_10',
  10:'qrcode', 11:'image_1', 12:'image_2', 13:'battery_status', 14:'connect_status',
};
const BLOCK_IDS: Record<string, number> = Object.fromEntries(Object.entries(BLOCK_NAMES).map(([k, v]) => [v, +k]));

const RESULT_NAMES: Record<number, string> = {
  0:'success', 1:'template id not exist', 2:'block id not exist',
  3:'content is too long', 4:'block unable to modify',
};

// ── Block config decode ───────────────────────────────────────────────────────
function decodeBlockConfig(blockId: number, b: number[]): any {
  const BLOCK_TYPES: Record<number, string> = { 0:'text', 1:'qrcode', 2:'image', 3:'battery_status', 4:'connect_status' };
  const BORDERS:     Record<number, string> = { 0:'no', 1:'yes' };
  const HALIGN:      Record<number, string> = { 0:'left', 1:'center', 2:'right' };
  const VALIGN:      Record<number, string> = { 0:'top', 1:'center', 2:'bottom' };
  const COLORS:      Record<number, string> = { 0:'white', 1:'black', 2:'red' };
  const FONT_TYPES:  Record<number, string> = {
    1:'SONG', 2:'FANG', 3:'BLACK', 4:'KAI', 5:'FT_ASCII', 6:'DZ_ASCII',
    7:'CH_ASCII', 8:'BX_ASCII', 9:'BZ_ASCII', 10:'FX_ASCII', 11:'GD_ASCII',
    12:'HZ_ASCII', 13:'MS_ASCII', 14:'SX_ASCII', 15:'ZY_ASCII', 16:'TM_ASCII',
    17:'YJ_LATIN', 18:'CYRILLIC', 19:'KSC5601', 20:'JIS0208_HT',
    21:'ARABIC', 22:'THAI', 23:'GREEK', 24:'HEBREW',
  };

  const cfg: any = {
    enable:     b[0] === 1 ? 'enable' : 'disable',
    type:       BLOCK_TYPES[b[1]] ?? 'unknown',
    start_x:    u16(b, 2),
    start_y:    u16(b, 4),
    end_x:      u16(b, 6),
    end_y:      u16(b, 8),
    border:     BORDERS[b[10]] ?? 'unknown',
    horizontal: HALIGN[b[11]] ?? 'unknown',
    vertical:   VALIGN[b[12]] ?? 'unknown',
    background: COLORS[b[13]] ?? 'unknown',
    foreground: COLORS[b[14]] ?? 'unknown',
    // b[15] reserved
    layer:      b[16] & 0xff,
    // b[17..20] reserved
  };

  // Text blocks (id 0-9) have font info at offset 21
  if (blockId < 10 && b.length >= 25) {
    cfg.font_type  = FONT_TYPES[b[21]] ?? 'unknown';
    cfg.font_size  = b[22] & 0xff;
    cfg.wrap       = b[23] === 1 ? 'enable' : 'disable';
    cfg.font_style = b[24] === 0 ? 'normal' : 'bold';
  }

  return cfg;
}

// ── Block config encode (returns the 21-25 byte struct, not the frame header) ─
function encodeBlockConfig(blockId: number, cfg: any): number[] {
  const BLOCK_TYPES: Record<string, number> = { text:0, qrcode:1, image:2, battery_status:3, connect_status:4 };
  const BORDERS:     Record<string, number> = { no:0, yes:1 };
  const HALIGN:      Record<string, number> = { left:0, center:1, right:2 };
  const VALIGN:      Record<string, number> = { top:0, center:1, bottom:2 };
  const COLORS:      Record<string, number> = { white:0, black:1, red:2 };
  const FONT_TYPES:  Record<string, number> = {
    SONG:1, FANG:2, BLACK:3, KAI:4, FT_ASCII:5, DZ_ASCII:6, CH_ASCII:7,
    BX_ASCII:8, BZ_ASCII:9, FX_ASCII:10, GD_ASCII:11, HZ_ASCII:12, MS_ASCII:13,
    SX_ASCII:14, ZY_ASCII:15, ZY_ASCII2:16, TM_ASCII:16, YJ_LATIN:17,
    CYRILLIC:18, KSC5601:19, JIS0208_HT:20, ARABIC:21, THAI:22, GREEK:23, HEBREW:24,
  };

  const basic: number[] = [
    cfg.enable === 'enable' ? 1 : 0,
    BLOCK_TYPES[cfg.type] ?? 0,
    ...wu16(cfg.start_x ?? 0),
    ...wu16(cfg.start_y ?? 0),
    ...wu16(cfg.end_x ?? 0),
    ...wu16(cfg.end_y ?? 0),
    BORDERS[cfg.border] ?? 0,
    HALIGN[cfg.horizontal] ?? 0,
    VALIGN[cfg.vertical] ?? 0,
    COLORS[cfg.background] ?? 0,
    COLORS[cfg.foreground] ?? 0,
    0x00, // reserved
    (cfg.layer ?? 0) & 0xff,
    0x00, 0x00, 0x00, 0x00, // reserved
  ];

  if (blockId < 10) {
    // Text block — append font info
    return [...basic,
      typeof cfg.font_type === 'number' ? cfg.font_type : (FONT_TYPES[cfg.font_type] ?? 1),
      cfg.font_size ?? 16,
      cfg.wrap === 'enable' ? 1 : 0,
      cfg.font_style === 'bold' ? 1 : 0,
    ];
  } else if (blockId === 10 || (blockId >= 11 && blockId <= 12)) {
    // QRCode / image — append codec/algorithm byte
    return [...basic, 0x00];
  }
  // battery_status / connect_status — no extension
  return basic;
}

export class MilesightDS3604Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ds3604';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['DS3604'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Device Management';
  readonly modelFamily     = 'DS3604';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ds-series/ds3604/ds3604.png';

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Standard attributes (0xFF) ─────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++]; decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2; }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Battery ─────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i++] & 0xff;
      }

      // ── Button status ─────────────────────────────────────────────────────
      else if (ch === 0xff && ty === 0x2e) {
        const bsm: Record<number, string> = { 0:'single_click', 1:'double_click', 2:'short_press', 3:'long_press' };
        decoded.button_status = bsm[bytes[i]] ?? 'unknown'; i += 1;
      }

      // ── Current template (0-indexed internally, 1-indexed output) ────────
      else if (ch === 0xff && ty === 0x73) {
        decoded.current_template_id = bytes[i++] + 1;
      }

      // ── Template content text/qrcode (0xFB 0x01) ──────────────────────────
      else if (ch === 0xfb && ty === 0x01) {
        const idByte    = bytes[i++];
        const templateId = (idByte >> 6) + 1;
        const blockId    = idByte & 0x3f;
        const blockLen   = bytes[i++];
        const text       = decodeUtf8(bytes.slice(i, i + blockLen));
        i += blockLen;

        const templateKey = `template_${templateId}`;
        decoded[templateKey] = decoded[templateKey] ?? {};
        const blockName = blockId < 10 ? `text_${blockId + 1}` : (blockId === 10 ? 'qrcode' : null);
        if (blockName) decoded[templateKey][blockName] = text;
      }

      // ── Image data (0xFB 0x02) — not decoded ─────────────────────────────
      else if (ch === 0xfb && ty === 0x02) {
        // Binary image payload — skip gracefully
        // Frame: id(1B) + seq_num(1B) + block_unit_size(1B) + data_length(1B) + data(NB)
        i += 2; // skip id and seq_num
        const blockUnitSize = bytes[i++];
        const dataLen = bytes[i++];
        i += dataLen;
        // Not exposing raw image bytes in decoded output
      }

      // ── Template block config (0xFB 0x03) ────────────────────────────────
      else if (ch === 0xfb && ty === 0x03) {
        const idByte    = bytes[i];
        const dataLen   = bytes[i + 1];
        const templateId = (idByte >> 6) + 1;
        const blockId    = idByte & 0x3f;
        i += 2;

        const configKey = `template_${templateId}_config`;
        decoded[configKey] = decoded[configKey] ?? {};
        const blockName = BLOCK_NAMES[blockId];
        if (blockName) {
          decoded[configKey][blockName] = decodeBlockConfig(blockId, bytes.slice(i, i + dataLen));
        }
        i += dataLen;
      }

      // ── Update content result (0xFA 0x01) ────────────────────────────────
      else if (ch === 0xfa && ty === 0x01) {
        const idByte    = bytes[i++];
        const templateId = (idByte >> 6) + 1;
        const blockId    = idByte & 0x3f;
        const blockName  = blockId < 10 ? `text_${blockId + 1}` : (blockId === 10 ? 'qrcode' : BLOCK_NAMES[blockId]);
        decoded.update_content_result = decoded.update_content_result ?? [];
        decoded.update_content_result.push({
          template_id: templateId, block_id: blockId,
          block_name: blockName,
          result: RESULT_NAMES[bytes[i++]] ?? 'unknown',
        });
      }

      // ── Receive image data result (0xFA 0x02) ─────────────────────────────
      else if (ch === 0xfa && ty === 0x02) {
        const idByte    = bytes[i++];
        const templateId = (idByte >> 6) + 1;
        const blockId    = idByte & 0x3f;
        decoded.receive_image_data_result = decoded.receive_image_data_result ?? [];
        decoded.receive_image_data_result.push({
          template_id: templateId, block_id: blockId,
          block_name: `image_${blockId}`,
          data_frame: bytes[i++],
        });
      }

      // ── Update template config result (0xFA 0x03) ─────────────────────────
      else if (ch === 0xfa && ty === 0x03) {
        const idByte    = bytes[i++];
        const templateId = (idByte >> 6) + 1;
        const blockId    = idByte & 0x3f;
        decoded.update_template_result = decoded.update_template_result ?? [];
        decoded.update_template_result.push({
          template_id: templateId, block_id: blockId,
          block_name: BLOCK_NAMES[blockId] ?? 'unknown',
          result: RESULT_NAMES[bytes[i++]] ?? 'unknown',
        });
      }

      // ── Downlink response echoes (0xFF or 0xFE channel) ────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlinkResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03: data.report_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x25: data.button_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x27: {
        const d = b[offset++];
        data.clear_image = {
          background_image: (d >> 4) & 0x01 ? 'yes' : 'no',
          logo_1: (d >> 5) & 0x01 ? 'yes' : 'no',
          logo_2: (d >> 5) & 0x02 ? 'yes' : 'no',
        }; break;
      }
      case 0x28: {
        const d = b[offset++];
        if (d === 0) data.report_battery = 'yes';
        else if (d === 1) data.report_buzzer = 'yes';
        else if (d === 2) data.report_current_template = 'yes';
        else if (d === 3) data.report_current_display = 'yes';
        break;
      }
      case 0x3d: {
        const d = b[offset++];
        if (d === 1) data.beep = 'yes';
        else if (d === 2) data.refresh_display = 'yes';
        break;
      }
      case 0x3e: data.buzzer_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x66: data.button_visible = b[offset++] === 1 ? 'show' : 'hide'; break;
      case 0x73: data.current_template_id = b[offset++] + 1; break;
      case 0x82: {
        const d = b[offset++];
        const mc: Record<string, string> = {};
        ['group_1','group_2','group_3','group_4'].forEach((g, idx) => {
          if ((d >> (idx + 4)) & 0x01) mc[g] = (d >> idx) & 0x01 ? 'enable' : 'disable';
        });
        data.multicast_config = mc; break;
      }
      case 0x89: {
        offset += 1; // skip sub-byte (0x02)
        const masked = u16(b, offset); const val = u16(b, offset + 2); offset += 4;
        const bv: Record<string, string> = {};
        Object.entries(BLOCK_NAMES).forEach(([bitStr, name]) => {
          const bit = +bitStr;
          if ((masked >> bit) & 1) bv[name] = (val >> bit) & 1 ? 'show' : 'hide';
        });
        data.block_visible = bv; break;
      }
      case 0x90: data.switch_template_button_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      default: offset += 1; break; // unknown response — skip one byte
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      // ── Set template text / qrcode content ────────────────────────────────
      // params: { template_id: 1|2, block_name: 'text_1'|...|'qrcode', text: string }
      case 'set_content': {
        const tid = (params.template_id ?? 1) - 1;           // 0-indexed
        const bid = BLOCK_IDS[params.block_name ?? 'text_1'] ?? 0;
        const idByte = ((tid & 0x03) << 6) | (bid & 0x3f);
        const utf8 = encodeUtf8(params.text ?? '');
        bytes = [0xfb, 0x01, idByte, utf8.length, ...utf8]; break;
      }

      // ── Change current template ────────────────────────────────────────────
      // params: { template_id: 1|2 }
      case 'set_current_template':
        bytes = [0xff, 0x73, (params.template_id ?? 1) - 1]; break;

      // ── Report interval ────────────────────────────────────────────────────
      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;

      // ── Reboot ─────────────────────────────────────────────────────────────
      case 'reboot': bytes = [0xff, 0x10, 0xff]; break;

      // ── Beep / refresh ─────────────────────────────────────────────────────
      case 'beep':            bytes = [0xff, 0x3d, 0x01]; break;
      case 'refresh_display': bytes = [0xff, 0x3d, 0x02]; break;

      // ── Report queries ─────────────────────────────────────────────────────
      case 'report_battery':              bytes = [0xff, 0x28, 0x00]; break;
      case 'report_buzzer':               bytes = [0xff, 0x28, 0x01]; break;
      case 'report_current_template_id':  bytes = [0xff, 0x28, 0x02]; break;
      case 'report_current_display':      bytes = [0xff, 0x28, 0x03]; break;

      // ── Boolean settings ───────────────────────────────────────────────────
      case 'set_buzzer_enable':
        bytes = [0xff, 0x3e, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_button_visible':
        bytes = [0xff, 0x66, params.visible === 'show' ? 1 : 0]; break;
      case 'set_button_enable':
        bytes = [0xff, 0x25, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_switch_template_button_enable':
        bytes = [0xff, 0x90, params.enable === 'enable' ? 1 : 0]; break;

      // ── Block visible (bit-masked) ─────────────────────────────────────────
      // params: { text_1: 'show'|'hide', text_2: ..., qrcode: ..., image_1: ..., battery_status: ..., ... }
      case 'set_block_visible': {
        let masked = 0, data = 0;
        for (const [name, bit] of Object.entries(BLOCK_IDS)) {
          if (name in params) {
            masked |= 1 << bit;
            if (params[name] === 'show') data |= 1 << bit;
          }
        }
        bytes = [0xff, 0x89, 0x02, ...wu16(masked), ...wu16(data)]; break;
      }

      // ── Clear images ───────────────────────────────────────────────────────
      // params: { background_image?: 'yes'|'no', logo_1?: 'yes'|'no', logo_2?: 'yes'|'no' }
      case 'clear_image': {
        let data = 0;
        if ('background_image' in params) data |= 1 << 4;
        if ('logo_1' in params || 'logo_2' in params) {
          data |= 1 << 5;
          if (params.logo_1 === 'yes') data |= 1 << 0;
          if (params.logo_2 === 'yes') data |= 1 << 1;
        }
        bytes = [0xff, 0x27, data]; break;
      }

      // ── Multicast config ────────────────────────────────────────────────────
      // params: { group_1?: 'enable'|'disable', group_2?: ..., group_3?: ..., group_4?: ... }
      case 'set_multicast_config': {
        let data = 0;
        ['group_1','group_2','group_3','group_4'].forEach((g, idx) => {
          if (g in params) {
            data |= 1 << (idx + 4);
            if (params[g] === 'enable') data |= 1 << idx;
          }
        });
        bytes = [0xff, 0x82, data]; break;
      }

      // ── Template block config ────────────────────────────────────────────
      // params: { template_id: 1|2, block_name: string, config: object }
      case 'set_template_config': {
        const tid = (params.template_id ?? 1) - 1;
        const bid = BLOCK_IDS[params.block_name ?? 'text_1'] ?? 0;
        const idByte = ((tid & 0x03) << 6) | (bid & 0x3f);
        const struct = encodeBlockConfig(bid, params.config ?? {});
        bytes = [0xfb, 0x03, idByte, struct.length, ...struct]; break;
      }

      default:
        throw new Error(`DS3604: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // DS3604 is uniquely identified by:
  //   0x01 0x75 — battery with unique type byte (DS3604-exclusive)
  //   0xFF 0x2E — button_status
  //   0xFF 0x73 — current_template_id
  //   0xFB xx   — template family channels

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x01 && ty === 0x75) return true; // battery (DS3604-specific type)
      if (ch === 0xff && ty === 0x2e) return true; // button_status
      if (ch === 0xff && ty === 0x73) return true; // current_template_id
      if (ch === 0xfb)                return true; // template data/config family
      if (ch === 0xfa)                return true; // operation results
    }
    return false;
  }
}