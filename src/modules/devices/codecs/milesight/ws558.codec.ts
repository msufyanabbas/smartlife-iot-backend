// src/modules/devices/codecs/milesight/ws558.codec.ts
/**
 * Milesight WS558 Codec
 * Smart Switch Controller with 8 Channels
 * 
 * Device Info:
 * - 8x relay switches (on/off control)
 * - Voltage monitoring
 * - Active power measurement
 * - Power consumption tracking
 * - Current monitoring
 * - Power factor
 * - Protocol: LoRaWAN 1.0.3
 * 
 * Based on official Milesight decoder v1.0.0
 */

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../interfaces/base-codec.interface';

export class MilesightWS558Codec extends BaseDeviceCodec {
  readonly codecId = 'milesight-ws558';
  readonly manufacturer = 'Milesight';
  readonly supportedModels = ['WS558', 'WS558-915', 'WS558-868'];
  readonly protocol = 'lorawan' as const;
  
  /**
   * Decode WS558 uplink payload
   * Based on official Milesight decoder
   */
  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};
    
    let i = 0;
    while (i < bytes.length) {
      const channelId = bytes[i++];
      const channelType = bytes[i++];
      
      // IPSO VERSION (0xFF 0x01)
      if (channelId === 0xff && channelType === 0x01) {
        const major = (bytes[i] & 0xf0) >> 4;
        const minor = bytes[i] & 0x0f;
        decoded.ipso_version = `v${major}.${minor}`;
        i += 1;
      }
      
      // HARDWARE VERSION (0xFF 0x09)
      else if (channelId === 0xff && channelType === 0x09) {
        const major = (bytes[i] & 0xff).toString(16);
        const minor = (bytes[i + 1] & 0xff) >> 4;
        decoded.hardware_version = `v${major}.${minor}`;
        i += 2;
      }
      
      // FIRMWARE VERSION (0xFF 0x0A)
      else if (channelId === 0xff && channelType === 0x0a) {
        const major = (bytes[i] & 0xff).toString(16);
        const minor = (bytes[i + 1] & 0xff).toString(16);
        decoded.firmware_version = `v${major}.${minor}`;
        i += 2;
      }
      
      // TSL VERSION (0xFF 0xFF)
      else if (channelId === 0xff && channelType === 0xff) {
        const major = bytes[i] & 0xff;
        const minor = bytes[i + 1] & 0xff;
        decoded.tsl_version = `v${major}.${minor}`;
        i += 2;
      }
      
      // SERIAL NUMBER (0xFF 0x16)
      else if (channelId === 0xff && channelType === 0x16) {
        const temp: string[] = [];
        for (let idx = 0; idx < 8; idx++) {
          temp.push(('0' + (bytes[i + idx] & 0xff).toString(16)).slice(-2));
        }
        decoded.sn = temp.join('');
        i += 8;
      }
      
      // LORAWAN CLASS (0xFF 0x0F)
      else if (channelId === 0xff && channelType === 0x0f) {
        const classMap: Record<number, string> = {
          0: 'Class A',
          1: 'Class B',
          2: 'Class C',
          3: 'Class CtoB',
        };
        decoded.lorawan_class = classMap[bytes[i]] || 'unknown';
        i += 1;
      }
      
      // RESET EVENT (0xFF 0xFE)
      else if (channelId === 0xff && channelType === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      
      // DEVICE STATUS (0xFF 0x0B)
      else if (channelId === 0xff && channelType === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }
      
      // VOLTAGE (0x03 0x74)
      else if (channelId === 0x03 && channelType === 0x74) {
        decoded.voltage = ((bytes[i + 1] << 8) + bytes[i]) / 10;
        i += 2;
      }
      
      // ACTIVE POWER (0x04 0x80)
      else if (channelId === 0x04 && channelType === 0x80) {
        decoded.active_power = (bytes[i + 3] << 24) + (bytes[i + 2] << 16) + (bytes[i + 1] << 8) + bytes[i];
        i += 4;
      }
      
      // POWER FACTOR (0x05 0x81)
      else if (channelId === 0x05 && channelType === 0x81) {
        decoded.power_factor = bytes[i] & 0xff;
        i += 1;
      }
      
      // POWER CONSUMPTION (0x06 0x83)
      else if (channelId === 0x06 && channelType === 0x83) {
        decoded.power_consumption = (bytes[i + 3] << 24) + (bytes[i + 2] << 16) + (bytes[i + 1] << 8) + bytes[i];
        i += 4;
      }
      
      // TOTAL CURRENT (0x07 0xC9)
      else if (channelId === 0x07 && channelType === 0xc9) {
        decoded.current = (bytes[i + 1] << 8) + bytes[i];
        i += 2;
      }
      
      // SWITCH STATUS (0x08 0x31) - 8 switches
      else if (channelId === 0x08 && channelType === 0x31) {
        const switchFlags = bytes[i + 1];
        
        // Decode all 8 switches
        for (let idx = 0; idx < 8; idx++) {
          const switchTag = `switch_${idx + 1}`;
          const status = (switchFlags >> idx) & 1;
          decoded[switchTag] = status === 1 ? 'on' : 'off';
        }
        
        i += 2;
      }
      
      // POWER CONSUMPTION ENABLE (0xFF 0x26)
      else if (channelId === 0xff && channelType === 0x26) {
        decoded.power_consumption_enable = bytes[i] === 1 ? 'enable' : 'disable';
        i += 1;
      }
      
      // DOWNLINK RESPONSES (0xFE or 0xFF with specific types)
      else if (channelId === 0xfe || channelId === 0xff) {
        const result = this.handleDownlinkResponse(channelType, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }
      
      // Unknown channel - skip
      else {
        break;
      }
    }
    
    return decoded;
  }
  
  /**
   * Handle downlink response
   */
  private handleDownlinkResponse(channelType: number, bytes: number[], offset: number): { data: any; offset: number } {
    const decoded: any = {};
    
    switch (channelType) {
      case 0x10: // Reboot
        decoded.reboot = bytes[offset] === 1 ? 'yes' : 'no';
        offset += 1;
        break;
        
      case 0x28: // Report Status
        decoded.report_status = bytes[offset] === 1 ? 'yes' : 'no';
        offset += 1;
        break;
        
      case 0x03: // Report Interval
        decoded.report_interval = (bytes[offset + 1] << 8) + bytes[offset];
        offset += 2;
        break;
        
      case 0x23: // Cancel Delay Task
        decoded.cancel_delay_task = bytes[offset] & 0xff;
        offset += 2; // Skip 1 byte
        break;
        
      case 0x26: // Power Consumption Enable
        decoded.power_consumption_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;
        
      case 0x27: // Clear Power Consumption
        decoded.clear_power_consumption = bytes[offset] === 1 ? 'yes' : 'no';
        offset += 1;
        break;
        
      case 0x32: // Delay Task
        decoded.delay_task = {};
        decoded.delay_task.task_id = bytes[offset] & 0xff;
        decoded.delay_task.delay_time = (bytes[offset + 2] << 8) + bytes[offset + 1];
        
        const mask = bytes[offset + 3] & 0xff;
        const status = bytes[offset + 4] & 0xff;
        
        offset += 5;
        
        const switchBitOffset = { 
          switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3,
          switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7 
        };
        
        for (const [key, bitPos] of Object.entries(switchBitOffset)) {
          if ((mask >> bitPos) & 0x01) {
            decoded.delay_task[key] = ((status >> bitPos) & 0x01) === 1 ? 'on' : 'off';
          }
        }
        break;
        
      default:
        // Unknown downlink response - skip
        break;
    }
    
    return { data: decoded, offset };
  }
  
  /**
   * Encode downlink command for WS558
   * Based on official Milesight encoder
   */
  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    
    switch (command.type) {
      case 'reboot':
        // Reboot device: [0xFF, 0x10, 0xFF]
        if (command.params?.reboot === 1 || command.params?.reboot === true) {
          bytes = [0xff, 0x10, 0xff];
        }
        break;
        
      case 'report_status':
        // Request status report: [0xFF, 0x28, 0xFF]
        if (command.params?.report_status === 1 || command.params?.report_status === true) {
          bytes = [0xff, 0x28, 0xff];
        }
        break;
        
      case 'set_reporting_interval':
      case 'report_interval':
        // Set report interval: [0xFF, 0x03, interval_low, interval_high]
        const interval = command.params?.interval || command.params?.report_interval || 300;
        bytes = [0xff, 0x03, interval & 0xff, (interval >> 8) & 0xff];
        break;
        
      case 'control_switch':
      case 'switch_control':
        // Control switches: [0x08, mask, status]
        const switchResult = this.encodeControlSwitch(command.params);
        bytes = switchResult;
        break;
        
      case 'control_switch_delay':
      case 'delay_task':
        // Control switches with delay: [0xFF, 0x32, task_id, delay_low, delay_high, mask, status]
        const delayResult = this.encodeControlSwitchWithDelay(command.params);
        bytes = delayResult;
        break;
        
      case 'cancel_delay_task':
        // Cancel delay task: [0xFF, 0x23, task_id, 0xFF]
        const taskId = command.params?.cancel_delay_task || command.params?.task_id || 0;
        if (taskId > 0) {
          bytes = [0xff, 0x23, taskId, 0xff];
        }
        break;
        
      case 'power_consumption_enable':
        // Enable/disable power consumption: [0xFF, 0x26, value]
        const enable = command.params?.power_consumption_enable === 1 || command.params?.power_consumption_enable === true ? 1 : 0;
        bytes = [0xff, 0x26, enable];
        break;
        
      case 'clear_power_consumption':
        // Clear power consumption: [0xFF, 0x27, 0xFF]
        if (command.params?.clear_power_consumption === 1 || command.params?.clear_power_consumption === true) {
          bytes = [0xff, 0x27, 0xff];
        }
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
  
  /**
   * Encode control switch command
   */
  private encodeControlSwitch(params: any): number[] {
    const switchBitOffset: Record<string, number> = {
      switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3,
      switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7,
    };
    
    let mask = 0;
    let status = 0;
    
    for (const [key, bitPos] of Object.entries(switchBitOffset)) {
      if (key in params) {
        mask |= 1 << bitPos;
        const value = params[key] === 1 || params[key] === 'on' || params[key] === true ? 1 : 0;
        status |= value << bitPos;
      }
    }
    
    return [0x08, mask, status];
  }
  
  /**
   * Encode control switch with delay
   */
  private encodeControlSwitchWithDelay(params: any): number[] {
    const taskId = params.task_id || 0;
    const delayTime = params.delay_time || 0;
    
    if (taskId < 0 || delayTime < 0) {
      throw new Error('task_id and delay_time must be >= 0');
    }
    
    const switchBitOffset: Record<string, number> = {
      switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3,
      switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7,
    };
    
    let mask = 0;
    let status = 0;
    
    for (const [key, bitPos] of Object.entries(switchBitOffset)) {
      if (key in params) {
        mask |= 1 << bitPos;
        const value = params[key] === 1 || params[key] === 'on' || params[key] === true ? 1 : 0;
        status |= value << bitPos;
      }
    }
    
    return [
      0xff,
      0x32,
      taskId,
      delayTime & 0xff,
      (delayTime >> 8) & 0xff,
      mask,
      status,
    ];
  }
  
  /**
   * Check if payload is from WS558
   */
  canDecode(payload: string | Buffer, metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    
    if (bytes.length < 2) return false;
    
    const channelId = bytes[0];
    const channelType = bytes[1];
    
    // Check for typical WS558 channel IDs
    // Voltage (0x03 0x74), Active Power (0x04 0x80), Switch Status (0x08 0x31)
    const ws558Signatures = [
      { ch: 0x03, type: 0x74 }, // Voltage
      { ch: 0x04, type: 0x80 }, // Active Power
      { ch: 0x05, type: 0x81 }, // Power Factor
      { ch: 0x06, type: 0x83 }, // Power Consumption
      { ch: 0x07, type: 0xc9 }, // Current
      { ch: 0x08, type: 0x31 }, // Switch Status
    ];
    
    return ws558Signatures.some(sig => 
      channelId === sig.ch && channelType === sig.type
    );
  }
}