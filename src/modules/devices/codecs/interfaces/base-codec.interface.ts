// src/modules/devices/codecs/base-codec.interface.ts
/**
 * Base Device Codec Interface
 * All device-specific codecs must implement this interface
 */

export interface DecodedTelemetry {
  // Standard fields (IoT best practices)
  temperature?: number;
  humidity?: number;
  pressure?: number;
  batteryLevel?: number;
  signalStrength?: number;
  latitude?: number;
  longitude?: number;
  
  // Motion/Occupancy
  motion?: boolean;
  occupancy?: boolean;
  
  // Light/Environmental
  illuminance?: number;
  co2?: number;
  tvoc?: number;
  
  // Energy
  voltage?: number;
  current?: number;
  power?: number;
  energy?: number;
  
  // Status
  alarmStatus?: string;
  doorStatus?: 'open' | 'closed';
  
  // Custom fields (device-specific)
  [key: string]: any;
}

export interface EncodedCommand {
  fPort?: number; // For LoRaWAN
  data: string; // Hex or Base64
  confirmed?: boolean;
}

export type TestDecodeBody = {
  payload: string;
  codecId?: string;
  manufacturer?: string;
  model?: string;
  fPort?: number;
};

export interface IDeviceCodec {
  /**
   * Unique identifier for this codec
   */
  readonly codecId: string;
  
  /**
   * Manufacturer name
   */
  readonly manufacturer: string;
  
  /**
   * Device model(s) this codec supports
   */
  readonly supportedModels: string[];
  
  /**
   * Protocol type
   */
  readonly protocol: 'lorawan' | 'mqtt' | 'http' | 'coap';
  
  /**
   * Decode uplink data (Device → Platform)
   * @param payload - Hex string, Base64, or raw bytes
   * @param fPort - LoRaWAN port number (optional)
   * @returns Decoded telemetry object
   */
  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry;
  
  /**
   * Encode downlink command (Platform → Device)
   * @param command - Command object with type and parameters
   * @returns Encoded command ready to send
   */
  encode(command: {
    type: string;
    params?: any;
  }): EncodedCommand;
  
  /**
   * Validate if this codec can handle the given payload
   * @param payload - Raw payload
   * @param metadata - Additional context (fPort, devEUI, etc.)
   * @returns true if codec can decode this payload
   */
  canDecode(payload: string | Buffer, metadata?: any): boolean;
}

/**
 * Abstract base class with common functionality
 */
export abstract class BaseDeviceCodec implements IDeviceCodec {
  abstract readonly codecId: string;
  abstract readonly manufacturer: string;
  abstract readonly supportedModels: string[];
  abstract readonly protocol: 'lorawan' | 'mqtt' | 'http' | 'coap';
  
  abstract decode(payload: string | Buffer, fPort?: number): DecodedTelemetry;
  abstract encode(command: { type: string; params?: any }): EncodedCommand;
  
  /**
   * Default implementation - override if needed
   */
  canDecode(payload: string | Buffer, metadata?: any): boolean {
    return true; // By default, assume codec can handle it
  }
  
  /**
   * Helper: Convert hex string to bytes
   */
  protected hexToBytes(hex: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
  }
  
  /**
   * Helper: Convert bytes to hex string
   */
  protected bytesToHex(bytes: number[]): string {
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * Helper: Check if payload is hex string
   */
  protected isHexString(str: string): boolean {
    return /^[0-9A-Fa-f]+$/.test(str);
  }
  
  /**
   * Helper: Check if payload is base64
   */
  protected isBase64(str: string): boolean {
    try {
      return Buffer.from(str, 'base64').toString('base64') === str;
    } catch {
      return false;
    }
  }
  
  /**
   * Helper: Normalize payload to bytes
   */
  protected normalizePayload(payload: string | Buffer): number[] {
    if (Buffer.isBuffer(payload)) {
      return Array.from(payload);
    }
    
    // Try hex first
    if (this.isHexString(payload)) {
      return this.hexToBytes(payload);
    }
    
    // Try base64
    if (this.isBase64(payload)) {
      return Array.from(Buffer.from(payload, 'base64'));
    }
    
    // Fallback: UTF-8
    return Array.from(Buffer.from(payload, 'utf-8'));
  }
}