// src/modules/devices/codecs/codec-registry.service.ts
/**
 * Codec Registry Service
 * Central registry for all device codecs
 * Automatically detects and routes to the correct codec
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDeviceCodec, DecodedTelemetry } from './interfaces/base-codec.interface';

@Injectable()
export class CodecRegistryService {
  private readonly logger = new Logger(CodecRegistryService.name);
  private readonly codecs = new Map<string, IDeviceCodec>();
  
  /**
   * Register a codec
   */
  registerCodec(codec: IDeviceCodec): void {
    this.codecs.set(codec.codecId, codec);
    this.logger.log(
      `✅ Registered codec: ${codec.codecId} (${codec.manufacturer} - ${codec.supportedModels.join(', ')})`,
    );
  }
  
  /**
   * Get codec by ID
   */
  getCodec(codecId: string): IDeviceCodec | undefined {
    return this.codecs.get(codecId);
  }
  
  /**
   * Find codec by manufacturer and model
   */
  findCodec(manufacturer: string, model: string): IDeviceCodec | undefined {
    for (const codec of this.codecs.values()) {
      if (
        codec.manufacturer.toLowerCase() === manufacturer.toLowerCase() &&
        codec.supportedModels.some(m => m.toLowerCase() === model.toLowerCase())
      ) {
        return codec;
      }
    }
    return undefined;
  }
  
  /**
   * Auto-detect codec for payload
   * Tries all codecs until one accepts the payload
   */
  detectCodec(
    payload: string | Buffer,
    metadata?: {
      fPort?: number;
      devEUI?: string;
      manufacturer?: string;
      model?: string;
    },
  ): IDeviceCodec | undefined {
    // If manufacturer/model provided, try that first
    if (metadata?.manufacturer && metadata?.model) {
      const codec = this.findCodec(metadata.manufacturer, metadata.model);
      if (codec && codec.canDecode(payload, metadata)) {
        return codec;
      }
    }
    
    // Try all registered codecs
    for (const codec of this.codecs.values()) {
      if (codec.canDecode(payload, metadata)) {
        this.logger.debug(`Auto-detected codec: ${codec.codecId}`);
        return codec;
      }
    }
    
    return undefined;
  }
  
  /**
   * Decode payload using appropriate codec
   * SMART: Auto-detects if decoding is needed
   */
  decode(
    payload: any,
    deviceMetadata?: {
      codecId?: string;
      manufacturer?: string;
      model?: string;
      fPort?: number;
      devEUI?: string;
      gatewayType?: string;
    },
  ): DecodedTelemetry {
    this.logger.debug(`\n🔍 Decode Request:`);
    this.logger.debug(`Payload Type: ${typeof payload}`);
    this.logger.debug(`Payload: ${JSON.stringify(payload).substring(0, 200)}`);
    
    // ============================================
    // CASE 1: Already decoded JSON object
    // ============================================
    if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      this.logger.debug(`✅ Payload already decoded (JSON object)`);
      
      // Check if it looks like decoded telemetry
      if (this.isDecodedTelemetry(payload)) {
        return payload as DecodedTelemetry;
      }
      
      // Check if it's wrapped (e.g., {data: {...}})
      if (payload.data && typeof payload.data === 'object') {
        this.logger.debug(`📦 Unwrapping nested data`);
        return payload.data as DecodedTelemetry;
      }
      
      // Return as-is
      return payload as DecodedTelemetry;
    }
    
    // ============================================
    // CASE 2: Needs decoding (hex/base64/binary)
    // ============================================
    this.logger.debug(`🔧 Payload needs decoding`);
    
    // Try to get specific codec
    let codec: IDeviceCodec | undefined;
    
    if (deviceMetadata?.codecId) {
      codec = this.getCodec(deviceMetadata.codecId);
      this.logger.debug(`Using specified codec: ${deviceMetadata.codecId}`);
    } else {
      // Auto-detect codec
      codec = this.detectCodec(payload, deviceMetadata);
      if (codec) {
        this.logger.debug(`Auto-detected codec: ${codec.codecId}`);
      }
    }
    
    if (!codec) {
      this.logger.warn(`⚠️  No codec found, returning raw payload`);
      return this.handleUnknownPayload(payload);
    }
    
    // Decode using codec
    try {
      const decoded = codec.decode(payload, deviceMetadata?.fPort);
      this.logger.debug(`✅ Decoded successfully using ${codec.codecId}`);
      this.logger.debug(`Decoded data: ${JSON.stringify(decoded)}`);
      return decoded;
    } catch (error) {
      this.logger.error(`❌ Decode error with ${codec.codecId}:`, error);
      return this.handleUnknownPayload(payload);
    }
  }
  
  /**
   * Encode command for device
   */
  encode(
    command: { type: string; params?: any },
    deviceMetadata: {
      codecId: string;
    },
  ): any {
    const codec = this.getCodec(deviceMetadata.codecId);
    
    if (!codec) {
      throw new Error(`Codec not found: ${deviceMetadata.codecId}`);
    }
    
    return codec.encode(command);
  }
  
  /**
   * List all registered codecs
   */
  listCodecs(): Array<{
    codecId: string;
    manufacturer: string;
    models: string[];
    protocol: string;
  }> {
    return Array.from(this.codecs.values()).map(codec => ({
      codecId: codec.codecId,
      manufacturer: codec.manufacturer,
      models: codec.supportedModels,
      protocol: codec.protocol,
    }));
  }
  
  /**
   * Check if object looks like decoded telemetry
   */
  private isDecodedTelemetry(obj: any): boolean {
    const telemetryFields = [
      'temperature',
      'humidity',
      'pressure',
      'batteryLevel',
      'motion',
      'occupancy',
      'latitude',
      'longitude',
    ];
    
    return telemetryFields.some(field => field in obj);
  }
  
  /**
   * Handle unknown/unparseable payload
   * Returns it as raw data
   */
  private handleUnknownPayload(payload: any): DecodedTelemetry {
    this.logger.warn(`Returning payload as raw_data`);
    
    let rawValue: string;
    
    if (Buffer.isBuffer(payload)) {
      rawValue = payload.toString('hex');
    } else if (typeof payload === 'string') {
      rawValue = payload;
    } else {
      rawValue = JSON.stringify(payload);
    }
    
    return {
      raw_data: rawValue,
      decoded: false,
      error: 'No codec available for this device',
    };
  }
}