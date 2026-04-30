// src/modules/devices/codecs/milesight/em300-mld.codec.ts
/**
 * Milesight EM300-MLD Codec
 * Membrane Leak Detection Sensor
 *
 * Channels: battery (0x01 0x75) + leakage_status (0x05 0x00)
 * NO temperature or humidity channels.
 * History:  timestamp(4B) + reserved(3B) + leakage_status(1B) = 8 bytes
 *
 * Reference: '01755C 050000'
 *   → { battery:92, leakage_status:'normal' }
 *
 * History: '20CE9E74466300000001'
 *   → { history:[{ timestamp:1665561758, leakage_status:'leak' }] }
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightEM300MLDCodec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-em300-mld';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['EM300-MLD'];
  readonly protocol = 'lorawan' as const;
  readonly category        = 'Leak Detection';
  readonly modelFamily     = 'EM300-MLD';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em300-mld/em300-mld.png';

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // Attribute channels
      if (ch === 0xff && ty === 0x01)  { decoded.ipso_version = `v${(bytes[i]&0xf0)>>4}.${bytes[i]&0x0f}`; i+=1; }
      else if (ch === 0xff && ty === 0x09) { decoded.hardware_version = `v${(bytes[i]&0xff).toString(16)}.${(bytes[i+1]&0xff)>>4}`; i+=2; }
      else if (ch === 0xff && ty === 0x0a) { decoded.firmware_version = `v${(bytes[i]&0xff).toString(16)}.${(bytes[i+1]&0xff).toString(16)}`; i+=2; }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`; i+=2; }
      else if (ch === 0xff && ty === 0x16) { decoded.sn = bytes.slice(i,i+8).map(b=>('0'+(b&0xff).toString(16)).slice(-2)).join(''); i+=8; }
      else if (ch === 0xff && ty === 0x0f) { const m:{[k:number]:string}={0:'Class A',1:'Class B',2:'Class C',3:'Class CtoB'}; decoded.lorawan_class=m[bytes[i]]??'unknown'; i+=1; }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event = bytes[i]===1?'reset':'normal'; i+=1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i]===1?'on':'off'; i+=1; }

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i]&0xff; decoded.batteryLevel = bytes[i]&0xff; i+=1;
      }
      // LEAKAGE STATUS (0x05 0x00) — MLD uses ch=0x05, SLD also uses 0x05
      else if (ch === 0x05 && ty === 0x00) {
        decoded.leakage_status = bytes[i]===1?'leak':'normal'; i+=1;
      }
      // HISTORY (0x20 0xCE) — 8 bytes: ts(4) + reserved(3) + leakage(1)
      else if (ch === 0x20 && ty === 0xce) {
        const ts = (((bytes[i+3]<<24)|(bytes[i+2]<<16)|(bytes[i+1]<<8)|bytes[i])>>>0);
        // bytes[i+4..i+6] reserved
        const lk = bytes[i+7]===1?'leak':'normal';
        if (!decoded.history) decoded.history=[];
        (decoded.history as any[]).push({ timestamp: ts, leakage_status: lk });
        i+=8;
      }
      else if (ch === 0xfe || ch === 0xff) {
        // Basic downlink handling
        const res = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, res.data); i = res.offset;
      }
      else { break; }
    }
    return decoded;
  }

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string,any>; offset: number } {
    const data: Record<string,any> = {};
    switch (ty) {
      case 0x03: data.report_interval = ((bytes[offset+1]<<8)|bytes[offset])&0xffff; offset+=2; break;
      case 0x10: data.reboot = 'yes'; offset+=1; break;
      case 0x68: data.history_enable = bytes[offset]===1?'enable':'disable'; offset+=1; break;
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
      default: throw new Error(`EM300-MLD: unsupported command "${command.type}"`);
    }
    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  // MLD: battery + leakage, NO temperature channel — that's the fingerprint
  canDecode(payload: string | Buffer, _m?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasBattery  = false;
    let hasLeakage  = false;
    let hasTemp     = false;
    for (let i = 0; i+1 < bytes.length;) {
      if (bytes[i] === 0x01 && bytes[i+1] === 0x75) hasBattery = true;
      if (bytes[i] === 0x05 && bytes[i+1] === 0x00) hasLeakage = true;
      if (bytes[i] === 0x03 && bytes[i+1] === 0x67) hasTemp    = true;
      i += 2;
    }
    // MLD has battery + leakage but NOT temperature
    return hasBattery && hasLeakage && !hasTemp;
  }
}