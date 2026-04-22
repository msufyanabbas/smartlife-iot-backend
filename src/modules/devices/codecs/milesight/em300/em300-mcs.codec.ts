// src/modules/devices/codecs/milesight/em300-mcs.codec.ts
/**
 * Milesight EM300-MCS Codec
 * Magnetic Contact Switch Sensor
 *
 * Extends EM300-TH: adds magnet_status channel (0x06 0x00)
 * History format: timestamp(4B) + temperature(2B) + humidity(1B) + magnet_status(1B)
 *
 * Reference: '01755C 03673401 046865 060001'
 *   → { battery:92, temperature:30.8, humidity:50.5, magnet_status:'open' }
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightEM300MCSCodec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-em300-mcs';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['EM300-MCS'];
  readonly protocol = 'lorawan' as const;

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ────────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] & 0xf0) >> 4}.${bytes[i] & 0x0f}`;
        i += 1;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i+8).map(b => ('0'+(b&0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const m: Record<number,string> = {0:'Class A',1:'Class B',2:'Class C',3:'Class CtoB'};
        decoded.lorawan_class = m[bytes[i]] ?? 'unknown';
        i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = bytes[i] & 0xff;
        i += 1;
      }
      // TEMPERATURE (0x03 0x67) — int16 LE / 10
      else if (ch === 0x03 && ty === 0x67) {
        const r = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (r > 0x7fff ? r - 0x10000 : r) / 10;
        i += 2;
      }
      // HUMIDITY (0x04 0x68) — uint8 / 2
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }
      // MAGNET STATUS (0x06 0x00) — 0: close, 1: open
      else if (ch === 0x06 && ty === 0x00) {
        decoded.magnet_status = bytes[i] === 1 ? 'open' : 'close';
        i += 1;
      }
      // HISTORY (0x20 0xCE) — 8 bytes: ts(4)+temp(2)+hum(1)+magnet(1)
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i+3]<<24)|(bytes[i+2]<<16)|(bytes[i+1]<<8)|bytes[i])>>>0);
        const tr   = ((bytes[i+5]<<8)|bytes[i+4]) & 0xffff;
        const temp = (tr > 0x7fff ? tr - 0x10000 : tr) / 10;
        const hum  = (bytes[i+6] & 0xff) / 2;
        const mag  = bytes[i+7] === 1 ? 'open' : 'close';
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({ timestamp: ts, temperature: temp, humidity: hum, magnet_status: mag });
        i += 8;
      }

      else if (ch === 0xfe || ch === 0xff) {
        const res = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, res.data);
        i = res.offset;
      }
      else { break; }
    }
    return decoded;
  }

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string,any>; offset: number } {
    const data: Record<string,any> = {};
    switch (ty) {
      case 0x03: data.report_interval = ((bytes[offset+1]<<8)|bytes[offset])&0xffff; offset+=2; break;
      case 0x02: data.collection_interval = ((bytes[offset+1]<<8)|bytes[offset])&0xffff; offset+=2; break;
      case 0x10: data.reboot = 'yes'; offset+=1; break;
      case 0x68: data.history_enable = bytes[offset]===1?'enable':'disable'; offset+=1; break;
      case 0x6a: {
        const t = bytes[offset]&0xff;
        if (t===0) data.retransmit_interval = ((bytes[offset+2]<<8)|bytes[offset+1])&0xffff;
        else       data.resend_interval     = ((bytes[offset+2]<<8)|bytes[offset+1])&0xffff;
        offset+=3; break;
      }
      default: offset+=1; break;
    }
    return { data, offset };
  }

  encode(command: { type: string; params?: any }): EncodedCommand {
    const p = command.params ?? {};
    let bytes: number[] = [];
    switch (command.type) {
      case 'reboot':                 bytes = [0xff,0x10,0xff]; break;
      case 'set_report_interval':    bytes = [0xff,0x03,(p.interval)&0xff,(p.interval>>8)&0xff]; break;
      case 'set_history_enable':     bytes = [0xff,0x68,p.enable?1:0]; break;
      default: throw new Error(`EM300-MCS: unsupported command "${command.type}"`);
    }
    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  canDecode(payload: string | Buffer, _m?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i+1 < bytes.length;) {
      if (bytes[i] === 0x06 && bytes[i+1] === 0x00) return true;
      i += 2;
    }
    return false;
  }
}