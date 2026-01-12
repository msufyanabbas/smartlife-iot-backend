// src/modules/devices/codecs/generic/mqtt-json.codec.ts
/**
 * Generic MQTT JSON Codec
 * For devices that already send decoded JSON data
 * (No encoding/decoding needed - pass-through)
 */

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../interfaces/base-codec.interface';

export class GenericMqttJsonCodec extends BaseDeviceCodec {
  readonly codecId = 'generic-mqtt-json';
  readonly manufacturer = 'Generic';
  readonly supportedModels = ['*']; // Supports any model
  readonly protocol = 'mqtt' as const;
  
  /**
   * Decode MQTT JSON payload
   * Most MQTT devices send already-decoded JSON
   */
  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    try {
      // Convert buffer to string if needed
      const jsonString = Buffer.isBuffer(payload) 
        ? payload.toString('utf-8') 
        : payload;
      
      // Parse JSON
      const parsed = JSON.parse(jsonString);
      
      // Return as-is (already decoded)
      return parsed as DecodedTelemetry;
    } catch (error) {
      // If parsing fails, return raw
      return {
        raw_data: payload.toString(),
        decoded: false,
        error: 'JSON parse error',
      };
    }
  }
  
  /**
   * Encode command as JSON
   */
  encode(command: { type: string; params?: any }): EncodedCommand {
    const payload = {
      command: command.type,
      params: command.params,
      timestamp: Date.now(),
    };
    
    return {
      data: JSON.stringify(payload),
      confirmed: false,
    };
  }
  
  /**
   * Check if payload is valid JSON
   */
  canDecode(payload: string | Buffer, metadata?: any): boolean {
    try {
      const jsonString = Buffer.isBuffer(payload) 
        ? payload.toString('utf-8') 
        : payload;
      
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  }
}