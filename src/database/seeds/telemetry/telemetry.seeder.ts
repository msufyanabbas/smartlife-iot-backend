import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class TelemetrySeeder implements ISeeder {
  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all devices - they should already have tenantId set from device seeder
    const devices = await this.deviceRepository.find({ take: 15 });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper to generate random number in range
    const randomInRange = (
      min: number,
      max: number,
      decimals: number = 2,
    ): number => {
      return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    };

    // Helper to generate timestamps for the last 7 days
    const generateTimestamps = (count: number): Date[] => {
      const now = new Date();
      const timestamps: Date[] = [];
      const intervalMs = (7 * 24 * 60 * 60 * 1000) / count; // Spread over 7 days

      for (let i = 0; i < count; i++) {
        const timestamp = new Date(now.getTime() - (count - i) * intervalMs);
        timestamps.push(timestamp);
      }
      return timestamps;
    };

    // Generate telemetry data for each device
    const telemetryBatch: any[] = [];
    const recordsPerDevice = 20; // Generate 20 records per device

    for (const device of devices) {
      const timestamps = generateTimestamps(recordsPerDevice);

      for (const timestamp of timestamps) {
        // Base telemetry with common fields
        const telemetry = {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          timestamp,
          temperature: randomInRange(15, 85),
          humidity: randomInRange(20, 90),
          pressure: randomInRange(900, 1100),
          batteryLevel: randomInRange(10, 100),
          signalStrength: Math.floor(randomInRange(-90, -30, 0)),
          latitude: randomInRange(24.6, 24.8, 7), // Riyadh area
          longitude: randomInRange(46.6, 46.8, 7), // Riyadh area
          data: {
            // Additional sensor data
            co2: randomInRange(400, 1500, 0),
            vibration: randomInRange(0, 100, 1),
            power: randomInRange(100, 800, 1),
            voltage: randomInRange(220, 240, 1),
            current: randomInRange(0.5, 5, 2),
            memoryUsage: randomInRange(30, 95, 1),
            cpuUsage: randomInRange(10, 90, 1),
            diskSpace: randomInRange(20, 95, 1),
            latency: randomInRange(10, 800, 0),
            uptime: randomInRange(0, 86400, 0), // seconds
            status: Math.random() > 0.1 ? 'online' : 'offline',
            errorCount: Math.floor(randomInRange(0, 10, 0)),
          },
          metadata: {
            source: 'mqtt',
            protocol: getRandomItem(['MQTT', 'HTTP', 'CoAP', 'WebSocket']),
            version: getRandomItem(['v1.0', 'v1.1', 'v2.0']),
            messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            qos: getRandomItem([0, 1, 2]),
          },
          tenantId: device.tenantId || null, // Inherit tenantId from device
        };

        telemetryBatch.push(telemetry);
      }
    }

    // Additional specialized telemetry scenarios matching alarm conditions
    const specialScenarios = [
      // Critical temperature scenario (matches "High Temperature Alert" alarm)
      ...Array.from({ length: 5 }, (_, i) => ({
        deviceId: devices[0].id,
        deviceKey: devices[0].deviceKey,
        timestamp: new Date(Date.now() - (5 - i) * 60 * 60 * 1000), // Last 5 hours
        temperature: randomInRange(75, 90),
        humidity: randomInRange(40, 60),
        pressure: randomInRange(1000, 1020),
        batteryLevel: randomInRange(80, 100),
        signalStrength: -45,
        data: {
          alert: 'high_temperature',
          severity: 'critical',
          threshold: 75,
        },
        metadata: {
          source: 'alert_system',
          triggeredAlarm: true,
        },
        tenantId: devices[0].tenantId || null,
      })),

      // Low battery scenario (matches "Low Battery Warning" alarm)
      ...Array.from({ length: 5 }, (_, i) => ({
        deviceId: devices[1]?.id || devices[0].id,
        deviceKey: devices[1]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (5 - i) * 30 * 60 * 1000), // Last 2.5 hours
        temperature: randomInRange(20, 30),
        humidity: randomInRange(50, 60),
        batteryLevel: randomInRange(5, 20),
        signalStrength: -65,
        data: {
          alert: 'low_battery',
          batteryVoltage: randomInRange(3.2, 3.6, 2),
          chargingState: 'not_charging',
        },
        metadata: {
          source: 'battery_monitor',
          triggeredAlarm: true,
        },
        tenantId: devices[1]?.tenantId || devices[0].tenantId || null,
      })),

      // High CO2 scenario (matches "CO2 Level Alert" alarm)
      ...Array.from({ length: 5 }, (_, i) => ({
        deviceId: devices[2]?.id || devices[0].id,
        deviceKey: devices[2]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (5 - i) * 45 * 60 * 1000), // Last 3.75 hours
        temperature: randomInRange(22, 26),
        humidity: randomInRange(45, 55),
        data: {
          co2: randomInRange(1000, 1500, 0),
          airQualityIndex: randomInRange(150, 200, 0),
          ventilationStatus: 'insufficient',
        },
        metadata: {
          source: 'air_quality_monitor',
          room: 'server-room-01',
          triggeredAlarm: true,
        },
        tenantId: devices[2]?.tenantId || devices[0].tenantId || null,
      })),

      // Device offline scenario (matches "Device Offline" alarm)
      ...Array.from({ length: 3 }, (_, i) => ({
        deviceId: devices[3]?.id || devices[0].id,
        deviceKey: devices[3]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (10 - i) * 60 * 60 * 1000), // 10, 9, 8 hours ago
        data: {
          status: 'offline',
          lastSeen: Date.now() - (10 - i) * 60 * 60 * 1000,
          connectionAttempts: randomInRange(1, 5, 0),
        },
        metadata: {
          source: 'connection_monitor',
          reason: 'no_response',
        },
        tenantId: devices[3]?.tenantId || devices[0].tenantId || null,
      })),

      // High pressure scenario (matches "Pressure Threshold Exceeded" alarm)
      ...Array.from({ length: 4 }, (_, i) => ({
        deviceId: devices[4]?.id || devices[0].id,
        deviceKey: devices[4]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (4 - i) * 30 * 60 * 1000), // Last 2 hours
        temperature: randomInRange(22, 28),
        humidity: randomInRange(40, 60),
        pressure: randomInRange(100, 110),
        data: {
          alert: 'high_pressure',
          severity: 'critical',
          threshold: 100,
        },
        metadata: {
          source: 'pressure_monitor',
          triggeredAlarm: true,
        },
        tenantId: devices[4]?.tenantId || devices[0].tenantId || null,
      })),

      // High vibration scenario (matches "Vibration Anomaly" alarm)
      ...Array.from({ length: 4 }, (_, i) => ({
        deviceId: devices[6]?.id || devices[0].id,
        deviceKey: devices[6]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (4 - i) * 20 * 60 * 1000), // Last 1.3 hours
        data: {
          vibration: randomInRange(50, 100, 1),
          alert: 'vibration_anomaly',
        },
        metadata: {
          source: 'vibration_sensor',
          sensor: 'accelerometer-01',
          location: 'motor-assembly',
          triggeredAlarm: true,
        },
        tenantId: devices[6]?.tenantId || devices[0].tenantId || null,
      })),

      // High network latency scenario (matches "Network Latency High" alarm)
      ...Array.from({ length: 4 }, (_, i) => ({
        deviceId: devices[7]?.id || devices[0].id,
        deviceKey: devices[7]?.deviceKey || devices[0].deviceKey,
        timestamp: new Date(Date.now() - (6 - i) * 60 * 60 * 1000), // Last 6 hours
        data: {
          latency: randomInRange(500, 900, 0),
          alert: 'high_latency',
          networkStatus: 'degraded',
        },
        metadata: {
          source: 'network_monitor',
          triggeredAlarm: true,
        },
        tenantId: devices[7]?.tenantId || devices[0].tenantId || null,
      })),
    ];

    telemetryBatch.push(...specialScenarios);

    // Save all telemetry records in batches
    const batchSize = 100;
    let savedCount = 0;

    for (let i = 0; i < telemetryBatch.length; i += batchSize) {
      const batch = telemetryBatch.slice(i, i + batchSize);
      const telemetryRecords = this.telemetryRepository.create(batch);
      await this.telemetryRepository.save(telemetryRecords);
      savedCount += batch.length;
      console.log(
        `✅ Saved ${savedCount}/${telemetryBatch.length} telemetry records...`,
      );
    }

    console.log(
      `🎉 Telemetry seeding completed! Total records: ${telemetryBatch.length}`,
    );
    console.log(`   - Regular records: ${devices.length * recordsPerDevice}`);
    console.log(`   - Special scenario records: ${specialScenarios.length}`);
    console.log(`   - Devices processed: ${devices.length}`);
  }
}
