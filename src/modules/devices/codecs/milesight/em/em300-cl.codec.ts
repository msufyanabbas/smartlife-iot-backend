// src/modules/devices/codecs/milesight/em300-cl.codec.ts
/**
 * Milesight EM300-CL Codec
 * Capacitive Level Sensor
 *
 * Channels:
 *   - battery           (0x01 0x75) — uint8 %
 *   - liquid            (0x03 0xED) — 0:uncalibrated, 1:full, 2:critical liquid level alert, 0xff:error
 *   - calibration_result(0x04 0xEE) — 0:failed, 1:success
 *   - liquid_alarm      (0x83 0xED) — liquid(1B) + alarm_type(1B)
 *
 * Reference: '017564 03ED01' → { battery:100, liquid:'full' }
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightEM300CLCodec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-em300-cl';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['EM300-CL'];
  readonly protocol = 'lorawan' as const;

  private readonly LIQUID_MAP: Record<number, string> = {
    0: 'uncalibrated',
    1: 'full',
    2: 'critical liquid level alert',
    255: 'error',
  };

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
      // LIQUID STATUS (0x03 0xED)
      else if (ch === 0x03 && ty === 0xed) {
        decoded.liquid = this.LIQUID_MAP[bytes[i]&0xff] ?? 'unknown'; i+=1;
      }
      // CALIBRATION RESULT (0x04 0xEE)
      else if (ch === 0x04 && ty === 0xee) {
        decoded.calibration_result = bytes[i]===1?'success':'failed'; i+=1;
      }
      // LIQUID ALARM (0x83 0xED) — liquid(1B) + alarm_type(1B)
      else if (ch === 0x83 && ty === 0xed) {
        decoded.liquid       = this.LIQUID_MAP[bytes[i]&0xff] ?? 'unknown';
        decoded.liquid_alarm = bytes[i+1]===1?'critical liquid level alarm':'critical liquid level alarm release';
        i+=2;
      }
      else if (ch === 0xfe || ch === 0xff) {
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
      case 0x10: data.reboot = 'yes'; offset+=1; break;
      case 0x62: data.calibrate = 'yes'; offset+=1; break;
      // Report interval uses a 3-byte format for CL: FF 8E 00 <uint16 LE>
      case 0x8e: data.report_interval = ((bytes[offset+2]<<8)|bytes[offset+1])&0xffff; offset+=3; break;
      case 0xbb: data.collection_interval = ((bytes[offset+2]<<8)|bytes[offset+1])&0xffff; offset+=3; break;
      default: offset+=1; break;
    }
    return { data, offset };
  }

  encode(command: { type: string; params?: any }): EncodedCommand {
    const p = command.params ?? {};
    let bytes: number[] = [];
    switch (command.type) {
      case 'reboot':      bytes = [0xff,0x10,0xff]; break;
      case 'calibrate':   bytes = [0xff,0x62,0xff]; break;
      case 'set_report_interval': {
        const v = p.interval ?? 20;
        bytes = [0xff,0x8e,0x00,v&0xff,(v>>8)&0xff]; break;
      }
      default: throw new Error(`EM300-CL: unsupported command "${command.type}"`);
    }
    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  canDecode(payload: string | Buffer, _m?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i+1 < bytes.length;) {
      // CL-unique channels
      if (bytes[i] === 0x03 && bytes[i+1] === 0xed) return true;
      if (bytes[i] === 0x04 && bytes[i+1] === 0xee) return true;
      if (bytes[i] === 0x83 && bytes[i+1] === 0xed) return true;
      i += 2;
    }
    return false;
  }
}