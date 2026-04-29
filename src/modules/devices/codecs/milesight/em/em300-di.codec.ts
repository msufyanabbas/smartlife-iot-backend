// src/modules/devices/codecs/milesight/em300-di.codec.ts
/**
 * Milesight EM300-DI Codec
 * Pulse Counter / Digital Input Sensor
 *
 * Channels (on top of TH base):
 *   - gpio          (0x05 0x00) — low/high
 *   - pulse         (0x05 0xC8) — uint32 LE counter
 *   - water/flow    (0x05 0xE1) — water_conv + pulse_conv + water float32 LE
 *   - gpio alarm    (0x85 0x00) — gpio + alarm_type
 *   - water alarm   (0x85 0xE1) — water data + alarm type
 *
 * History v1 (0x20 0xCE) — 13 bytes: ts(4)+temp(2)+hum(1)+gpio_type(1)+gpio(1)+pulse(4)
 * History v2 (0x21 0xCE) — 18 bytes: ts(4)+temp(2)+hum(1)+alarm(1)+gpio_type(1)+gpio(1)+wconv(2)+pconv(2)+water(4)
 *
 * EM300-DI-HALL shares the identical format — thin subclass.
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightEM300DICodec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-em300-di';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['EM300-DI'];
  readonly protocol = 'lorawan' as const;

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
      // TEMPERATURE (0x03 0x67)
      else if (ch === 0x03 && ty === 0x67) {
        const r = ((bytes[i+1]<<8)|bytes[i])&0xffff;
        decoded.temperature = (r>0x7fff?r-0x10000:r)/10; i+=2;
      }
      // HUMIDITY (0x04 0x68)
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i]&0xff)/2; i+=1;
      }
      // GPIO DIGITAL (0x05 0x00)
      else if (ch === 0x05 && ty === 0x00) {
        decoded.gpio = bytes[i]===1?'high':'low'; i+=1;
      }
      // PULSE COUNTER (0x05 0xC8) — uint32 LE
      else if (ch === 0x05 && ty === 0xc8) {
        decoded.pulse = (((bytes[i+3]<<24)|(bytes[i+2]<<16)|(bytes[i+1]<<8)|bytes[i])>>>0);
        i+=4;
      }
      // WATER / FLOW (0x05 0xE1) — water_conv(2)+pulse_conv(2)+water float32(4)
      else if (ch === 0x05 && ty === 0xe1) {
        decoded.water_conv  = (((bytes[i+1]<<8)|bytes[i])&0xffff)/10;
        decoded.pulse_conv  = (((bytes[i+3]<<8)|bytes[i+2])&0xffff)/10;
        decoded.water       = this.readFloat32LE(bytes, i+4);
        i+=8;
      }
      // GPIO ALARM (0x85 0x00)
      else if (ch === 0x85 && ty === 0x00) {
        decoded.gpio       = bytes[i]===1?'high':'low';
        decoded.gpio_alarm = bytes[i+1]===1?'gpio alarm':'gpio alarm release';
        i+=2;
      }
      // WATER ALARM (0x85 0xE1)
      else if (ch === 0x85 && ty === 0xe1) {
        decoded.water_conv  = (((bytes[i+1]<<8)|bytes[i])&0xffff)/10;
        decoded.pulse_conv  = (((bytes[i+3]<<8)|bytes[i+2])&0xffff)/10;
        decoded.water       = this.readFloat32LE(bytes, i+4);
        const wAlarmMap: Record<number,string> = {
          1:'water outage timeout alarm', 2:'water outage timeout alarm release',
          3:'water flow timeout alarm',   4:'water flow timeout alarm release',
        };
        decoded.water_alarm = wAlarmMap[bytes[i+8]] ?? 'unknown';
        i+=9;
      }
      // HISTORY v1 (0x20 0xCE) — 13 bytes
      else if (ch === 0x20 && ty === 0xce) {
        if (bytes.length - i < 11) break;
        const ts   = (((bytes[i+3]<<24)|(bytes[i+2]<<16)|(bytes[i+1]<<8)|bytes[i])>>>0);
        const tr   = ((bytes[i+5]<<8)|bytes[i+4])&0xffff;
        const temp = (tr>0x7fff?tr-0x10000:tr)/10;
        const hum  = (bytes[i+6]&0xff)/2;
        const mode = bytes[i+7];
        const point: Record<string,any> = {
          timestamp: ts, temperature: temp, humidity: hum,
          gpio_type: mode===1?'gpio':mode===2?'counter':'unknown',
        };
        if (mode === 1) point.gpio  = bytes[i+8]===1?'high':'low';
        else if (mode === 2) point.pulse = (((bytes[i+12]<<24)|(bytes[i+11]<<16)|(bytes[i+10]<<8)|bytes[i+9])>>>0);
        if (!decoded.history) decoded.history=[];
        (decoded.history as any[]).push(point);
        i+=13;
      }
      // HISTORY v2 (0x21 0xCE) — 18 bytes
      else if (ch === 0x21 && ty === 0xce) {
        const ts   = (((bytes[i+3]<<24)|(bytes[i+2]<<16)|(bytes[i+1]<<8)|bytes[i])>>>0);
        const tr   = ((bytes[i+5]<<8)|bytes[i+4])&0xffff;
        const temp = (tr>0x7fff?tr-0x10000:tr)/10;
        const hum  = (bytes[i+6]&0xff)/2;
        const alarmMap: Record<number,string> = {
          0:'none',1:'water outage timeout alarm',2:'water outage timeout alarm release',
          3:'water flow timeout alarm',4:'water flow timeout alarm release',5:'gpio alarm',6:'gpio alarm release',
        };
        const alarm   = alarmMap[bytes[i+7]]??'unknown';
        const mode    = bytes[i+8];
        const point: Record<string,any> = {
          timestamp: ts, temperature: temp, humidity: hum,
          alarm, gpio_type: mode===1?'gpio':mode===2?'counter':'unknown',
        };
        if (mode === 1) {
          point.gpio = bytes[i+9]===1?'high':'low';
        } else if (mode === 2) {
          point.water_conv = (((bytes[i+11]<<8)|bytes[i+10])&0xffff)/10;
          point.pulse_conv = (((bytes[i+13]<<8)|bytes[i+12])&0xffff)/10;
          point.water      = this.readFloat32LE(bytes, i+14);
        }
        if (!decoded.history) decoded.history=[];
        (decoded.history as any[]).push(point);
        i+=18;
      }
      else if (ch === 0xfe || ch === 0xff) {
        const res = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, res.data); i = res.offset;
      }
      else { break; }
    }
    return decoded;
  }

  private readFloat32LE(bytes: number[], offset: number): number {
    const bits = (((bytes[offset+3]<<24)|(bytes[offset+2]<<16)|(bytes[offset+1]<<8)|bytes[offset])>>>0);
    const sign = bits>>>31===0?1.0:-1.0;
    const e    = (bits>>>23)&0xff;
    const m    = e===0?(bits&0x7fffff)<<1:(bits&0x7fffff)|0x800000;
    return Number((sign*m*Math.pow(2,e-150)).toFixed(2));
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
      case 0xc3: {
        const modeMap: Record<number,string> = {1:'digital',2:'counter'};
        data.gpio_mode = modeMap[bytes[offset]]??'unknown'; offset+=1; break;
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
      case 'set_gpio_mode':          bytes = [0xff,0xc3,p.mode==='digital'?1:2]; break;
      case 'clear_counter':          bytes = [0xff,0x4e,0x01,0x00]; break;
      default: throw new Error(`EM300-DI: unsupported command "${command.type}"`);
    }
    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  canDecode(payload: string | Buffer, _m?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i+1 < bytes.length;) {
      // GPIO digital, pulse, or water channels are unique to DI
      if (bytes[i] === 0x05 && (bytes[i+1] === 0xc8 || bytes[i+1] === 0xe1)) return true;
      if (bytes[i] === 0x85 && (bytes[i+1] === 0x00 || bytes[i+1] === 0xe1)) return true;
      i += 2;
    }
    return false;
  }
}