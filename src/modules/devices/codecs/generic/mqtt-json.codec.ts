import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../interfaces/base-codec.interface';

/**
 * Generic MQTT JSON Codec
 *
 * For devices that already publish decoded JSON over MQTT (ESP32, Arduino,
 * Shelly, custom firmware, etc.).  The payload arrives as a UTF-8 JSON string
 * and is returned as-is after parsing.
 *
 * IMPORTANT — codec priority:
 * canDecode() returns false by default so that this codec is NEVER chosen
 * during auto-detection.  It must be selected explicitly via codecId on the
 * device metadata (e.g. metadata.codecId = 'generic-mqtt-json').
 *
 * Reason: returning true for any valid JSON would greedily match LoRaWAN
 * payloads that are already-decoded JSON wrappers (e.g. from ChirpStack),
 * preventing the correct device-specific codec from being tried first.
 */
export class GenericMqttJsonCodec extends BaseDeviceCodec {
  readonly codecId = 'generic-mqtt-json';
  readonly manufacturer = 'Generic';
  readonly supportedModels = ['*'];
  readonly protocol = 'mqtt' as const;

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    try {
      const str = Buffer.isBuffer(payload) ? payload.toString('utf-8') : payload;
      return JSON.parse(str) as DecodedTelemetry;
    } catch {
      return {
        raw_data: payload.toString(),
        decoded: false,
        error: 'JSON parse error',
      };
    }
  }

  encode(command: { type: string; params?: any }): EncodedCommand {
    return {
      data: JSON.stringify({
        command: command.type,
        params: command.params,
        timestamp: Date.now(),
      }),
      confirmed: false,
    };
  }

  /**
   * Always returns false — this codec must be selected explicitly via
   * device.metadata.codecId = 'generic-mqtt-json'.
   * It is never chosen during auto-detection.
   */
  canDecode(_payload: string | Buffer, _metadata?: any): boolean {
    return false;
  }
}