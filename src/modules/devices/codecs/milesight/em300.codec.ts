// src/modules/devices/codecs/milesight/em300.codec.ts
/**
 * Milesight EM300 Series Codec
 * Supports: EM300-TH, EM300-MCS, EM300-DI, etc.
 * 
 * Common EM300 series environmental sensors
 */

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../interfaces/base-codec.interface';

export class MilesightEM300Codec extends BaseDeviceCodec {
  readonly codecId = 'milesight-em300';
  readonly manufacturer = 'Milesight';
  readonly supportedModels = [
    'EM300-TH',   // Temperature & Humidity
    'EM300-MCS',  // Magnetic Contact Switch (Door/Window)
    'EM300-DI',   // Digital Input
    'EM300-ZLD',  // Zone Leak Detection
  ];
  readonly protocol = 'lorawan' as const;
  
  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};
    
    let i = 0;
    while (i < bytes.length) {
      const channelId = bytes[i++];
      const channelType = bytes[i++];
      
      // Temperature (0x03 0x67)
      if (channelId === 0x03 && channelType === 0x67) {
        const temp = (bytes[i] | (bytes[i + 1] << 8));
        decoded.temperature = (temp - 0x7FFF) / 10 / 10; // Signed
        i += 2;
      }
      
      // Humidity (0x04 0x68)
      else if (channelId === 0x04 && channelType === 0x68) {
        decoded.humidity = bytes[i] / 2;
        i += 1;
      }
      
      // Battery (0x01 0x75)
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.batteryLevel = bytes[i];
        i += 1;
      }
      
      // Door/Window Status (0x05 0x00)
      else if (channelId === 0x05 && channelType === 0x00) {
        decoded.doorStatus = bytes[i] === 0x01 ? 'open' : 'closed';
        decoded.contact = bytes[i] === 0x00; // true = closed
        i += 1;
      }
      
      // Water Leak (0x06 0x00)
      else if (channelId === 0x06 && channelType === 0x00) {
        decoded.waterLeak = bytes[i] === 0x01;
        i += 1;
      }
      
      // Digital Input (0x07 0x00)
      else if (channelId === 0x07 && channelType === 0x00) {
        decoded.digitalInput = bytes[i];
        i += 1;
      }
      
      else {
        i += 1;
      }
    }
    
    return decoded;
  }
  
  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    
    switch (command.type) {
      case 'set_reporting_interval':
        const interval = command.params?.interval || 60;
        bytes = [0xFF, 0x8E, interval & 0xFF, (interval >> 8) & 0xFF];
        break;
        
      default:
        throw new Error(`Unsupported command: ${command.type}`);
    }
    
    return {
      fPort: 85,
      data: this.bytesToHex(bytes),
      confirmed: false,
    };
  }
  
  canDecode(payload: string | Buffer, metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;
    
    const firstChannel = bytes[0];
    return [0x01, 0x03, 0x04, 0x05, 0x06, 0x07].includes(firstChannel);
  }
}