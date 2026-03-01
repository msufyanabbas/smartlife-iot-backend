import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Device, Tenant } from '@modules/index.entities';

@Entity('telemetry')
@Index(['tenantId', 'deviceId', 'timestamp'])
@Index(['tenantId', 'deviceKey', 'timestamp'])
@Index(['timestamp'])
export class Telemetry extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE REFERENCE
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  deviceId: string;

  @ManyToOne(() => Device)
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column()

  deviceKey: string;  // Denormalized for fast queries

  // ══════════════════════════════════════════════════════════════════════════
  // TIMESTAMP (Time-series data)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp' })

  timestamp: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // TELEMETRY DATA (Flexible JSONB + Common Fields)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  data: Record<string, any>;

  // Example from Temperature Sensor:
  // data: {
  //   temperature: 25.5,
  //   humidity: 60,
  //   pressure: 1013,
  //   co2: 450,
  //   voc: 120
  // }
  //
  // Example from GPS Tracker:
  // data: {
  //   latitude: 24.7136,
  //   longitude: 46.6753,
  //   speed: 45,
  //   heading: 180,
  //   altitude: 612
  // }
  //
  // Example from Smart Meter:
  // data: {
  //   voltage: 220,
  //   current: 5.2,
  //   power: 1144,
  //   energy: 15.3,
  //   frequency: 50
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // COMMON FIELDS (Denormalized for fast queries - duplicates from data JSONB)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  temperature?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  humidity?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  pressure?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  batteryLevel?: number;

  @Column({ type: 'int', nullable: true })
  signalStrength?: number;  // RSSI in dBm

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA (Info about the telemetry reading itself)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;
  // Example:
  // metadata: {
  //   source: 'mqtt',              // How data arrived (mqtt, http, lorawan)
  //   topic: 'devices/ws202-001/telemetry',
  //   protocol: 'lorawan',
  //   gatewayId: 'gateway-123',
  //   rssi: -85,                   // Signal strength at gateway
  //   snr: 7.5,                    // Signal-to-noise ratio
  //   frequency: 868100000,        // LoRa frequency
  //   dataRate: 'SF7BW125',
  //   receivedAt: 1704067200000    // When backend received it
  // }
}
