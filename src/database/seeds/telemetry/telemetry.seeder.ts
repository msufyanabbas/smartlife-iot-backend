// src/database/seeds/telemetry/telemetry.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry, Device, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class TelemetrySeeder implements ISeeder {
  private readonly logger = new Logger(TelemetrySeeder.name);

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting telemetry seeding with full field coverage & tenant validation...');

    // Fetch devices with tenant information
    const devices = await this.deviceRepository.find({
      take: 20,
    });

    if (devices.length === 0) {
      this.logger.warn('⚠️ No devices found. Please seed devices first.');
      return;
    }

    const telemetryBatch: Partial<Telemetry>[] = [];
    const recordsPerDevice = 20;

    // Helper functions
    const randomInRange = (min: number, max: number, decimals = 2): number =>
      parseFloat((Math.random() * (max - min) + min).toFixed(decimals));

    const getRandomItem = <T>(array: T[]): T => array[Math.floor(Math.random() * array.length)];

    for (const device of devices) {
      // Inherit tenantId from device
      const tenantId = device.tenantId;

      if (!tenantId) {
        this.logger.warn(`⚠️ Skipping device ${device.name} (${device.id}) because it has no tenantId.`);
        continue;
      }

      // Validate tenant exists (Consistency pattern requested by user)
      const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
      if (!tenant) {
        this.logger.warn(`⚠️ Tenant ${tenantId} not found for device ${device.name}. Skipping telemetry.`);
        continue;
      }

      const now = new Date();
      for (let i = 0; i < recordsPerDevice; i++) {
        const timestamp = new Date(now.getTime() - i * 15 * 60 * 1000); // Every 15 minutes

        // Generate random values for all possible entity fields
        const temp = randomInRange(18, 35);
        const hum = randomInRange(30, 80);
        const press = randomInRange(950, 1050);
        const lat = randomInRange(24.6, 24.8, 7); // Riyadh area
        const lng = randomInRange(46.6, 46.8, 7); // Riyadh area
        const battery = randomInRange(10, 100);
        const rssi = Math.floor(randomInRange(-100, -30, 0));

        const telemetryData: Partial<Telemetry> = {
          // ════════════════════════════════════════════════════════════════
          // 1. TENANT SCOPE (Mandatory)
          // ════════════════════════════════════════════════════════════════
          tenantId: tenantId,

          // ════════════════════════════════════════════════════════════════
          // 2. DEVICE REFERENCE (Mandatory)
          // ════════════════════════════════════════════════════════════════
          deviceId: device.id,
          deviceKey: device.deviceKey,

          // ════════════════════════════════════════════════════════════════
          // 3. TIMESTAMP (Mandatory)
          // ════════════════════════════════════════════════════════════════
          timestamp,

          // ════════════════════════════════════════════════════════════════
          // 4. COMMON FIELDS (Denormalized for fast queries)
          // ════════════════════════════════════════════════════════════════
          temperature: temp,
          humidity: hum,
          pressure: press,
          latitude: lat,
          longitude: lng,
          batteryLevel: battery,
          signalStrength: rssi,

          // ════════════════════════════════════════════════════════════════
          // 5. FLEXIBLE DATA (Full JSONB Payload)
          // ════════════════════════════════════════════════════════════════
          data: {
            temperature: temp,
            humidity: hum,
            pressure: press,
            latitude: lat,
            longitude: lng,
            batteryLevel: battery,
            signalStrength: rssi,
            co2: randomInRange(400, 1200, 0),
            voc: randomInRange(100, 500, 0),
            vibration: randomInRange(0, 10, 2),
            uptime: Math.floor(randomInRange(0, 1000000, 0)),
            status: 'online',
          },

          // ════════════════════════════════════════════════════════════════
          // 6. METADATA (Internal Backend Info)
          // ════════════════════════════════════════════════════════════════
          metadata: {
            source: getRandomItem(['mqtt', 'http', 'lorawan', 'coap']),
            protocol: getRandomItem(['v1.1', 'v2.0', 'v3.1.1']),
            gatewayId: `gw-${tenantId.slice(0, 4)}-${Math.floor(Math.random() * 100)}`,
            rssi: rssi,
            snr: randomInRange(0, 15, 1),
            receivedAt: timestamp.getTime() + 50, // simulated delay
          },
        };

        telemetryBatch.push(telemetryData);
      }
    }

    // Save in batches for performance
    const batchSize = 100;
    for (let i = 0; i < telemetryBatch.length; i += batchSize) {
      const batch = telemetryBatch.slice(i, i + batchSize);
      const records = this.telemetryRepository.create(batch);
      await this.telemetryRepository.save(records);
    }

    this.logger.log(`🎉 Telemetry seeding complete! Saved ${telemetryBatch.length} records for ${devices.length} devices.`);
  }
}
