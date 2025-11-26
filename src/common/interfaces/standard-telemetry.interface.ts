// src/common/interfaces/standard-telemetry.interface.ts
// UNIFIED format that ALL protocols convert to

/**
 * Standard Telemetry Format
 * All protocol adapters MUST convert their data to this format
 */
export interface StandardTelemetry {
  // Device identification
  deviceId: string; // Your internal device ID
  deviceKey: string; // Device unique key
  tenantId?: string; // Multi-tenant support

  // Telemetry data (flexible JSON)
  data: Record<string, any>; // Any sensor data: {temperature: 25, humidity: 60}

  // Common sensor values (extracted from data for easy querying)
  temperature?: number;
  humidity?: number;
  pressure?: number;
  latitude?: number;
  longitude?: number;
  batteryLevel?: number;
  signalStrength?: number;

  // Metadata
  timestamp: Date | string; // When data was collected
  receivedAt?: number; // When platform received it (epoch ms)

  // Protocol-specific info
  protocol:
    | 'mqtt'
    | 'http'
    | 'coap'
    | 'lorawan'
    | 'modbus'
    | 'websocket'
    | 'ble';
  metadata?: {
    // MQTT
    topic?: string;
    qos?: number;

    // HTTP
    method?: string;
    endpoint?: string;

    // LoRaWAN
    rssi?: number;
    snr?: number;
    frequency?: number;
    dataRate?: number;
    frameCounter?: number;
    port?: number;

    // CoAP
    coapMethod?: string;
    coapPath?: string;

    // Any other metadata
    [key: string]: any;
  };

  // Raw payload (for debugging/audit)
  rawPayload?: any;
}

/**
 * Device Connection Info
 * Information about how device is connected
 */
export interface DeviceConnection {
  deviceId: string;
  protocol: string;
  connected: boolean;
  lastSeen: Date;
  connectionDetails?: {
    clientId?: string;
    ipAddress?: string;
    port?: number;
    [key: string]: any;
  };
}

/**
 * Protocol Adapter Interface
 * All protocol adapters MUST implement this
 */
export interface IProtocolAdapter {
  // Protocol name
  protocol: string;

  // Start listening for devices
  start(): Promise<void>;

  // Stop listening
  stop(): Promise<void>;

  // Parse raw payload to StandardTelemetry
  parse(rawPayload: any, context?: any): StandardTelemetry;

  // Send command to device (optional - for bi-directional protocols)
  sendCommand?(deviceId: string, command: any): Promise<void>;
}
