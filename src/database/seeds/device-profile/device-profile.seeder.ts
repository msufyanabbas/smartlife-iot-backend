// src/database/seeds/device-profile/device-profile.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceProfile } from '@modules/profiles/entities/device-profile.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import {
  AlarmConditionKeyType,
  AlarmConditionSpecType,
  AlarmConditionValueType,
  AlarmPredicateOperation,
  CoapPowerMode,
  DevicePayloadType,
  DeviceProvisionType,
  DeviceTransportType,
} from '@common/enums/index.enum';
import type {
  DeviceProfileAlarmRule,
  DeviceTransportConfiguration,
} from '@common/interfaces/index.interface';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds the 7 stock device profiles for EVERY tenant.
 *
 * Replaces the previous seeder, which hardcoded tenants[0..2] and so left
 * three of six tenants with no profiles (and no default profile at all).
 *
 * Re-runnable: profiles are matched on (tenantId, name) and existing rows are
 * updated in place, so the uppercase transport/provision values and the new
 * alarm-rule shape are backfilled onto databases seeded before this change.
 */

interface ProfileDefinition {
  name: string;
  description: string;
  type: string;
  transportType: DeviceTransportType;
  provisionType: DeviceProvisionType;
  default?: boolean;
  transportConfiguration?: DeviceTransportConfiguration;
  alarmRules?: DeviceProfileAlarmRule[];
}

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  {
    name: 'Default',
    description: 'Default device profile for all devices',
    type: 'DEFAULT',
    transportType: DeviceTransportType.DEFAULT,
    provisionType: DeviceProvisionType.DISABLED,
    default: true,
  },
  {
    name: 'MQTT Sensor',
    description: 'Standard MQTT sensor profile',
    type: 'DEFAULT',
    transportType: DeviceTransportType.MQTT,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    transportConfiguration: {
      mqtt: {
        deviceTelemetryTopic: 'v1/devices/me/telemetry',
        devicePayloadType: DevicePayloadType.JSON,
      },
    },
    alarmRules: [],
  },
  {
    name: 'HTTP Device',
    description: 'HTTP-based device profile',
    type: 'DEFAULT',
    transportType: DeviceTransportType.HTTP,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    transportConfiguration: { http: { maxPayloadSize: 65536 } },
  },
  {
    name: 'CoAP Device',
    description: 'CoAP UDP device profile',
    type: 'DEFAULT',
    transportType: DeviceTransportType.COAP,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    transportConfiguration: { coap: { powerMode: CoapPowerMode.DRX } },
  },
  {
    name: 'Temperature Sensor',
    description: 'Temperature monitoring device with high-temp alarm',
    type: 'DEFAULT',
    transportType: DeviceTransportType.MQTT,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    alarmRules: [
      {
        id: 'alarm-1',
        alarmType: 'High Temperature',
        enabled: true,
        severity: 'critical',
        propagate: true,
        propagateToOwner: true,
        propagateToTenant: false,
        condition: {
          spec: { type: AlarmConditionSpecType.SIMPLE },
          condition: [
            {
              key: 'temperature',
              type: AlarmConditionKeyType.TIME_SERIES,
              valueType: AlarmConditionValueType.NUMERIC,
              predicate: {
                operation: AlarmPredicateOperation.GREATER,
                value: { defaultValue: 40 },
              },
            },
          ],
        },
        clearRule: {
          condition: [
            {
              key: 'temperature',
              type: AlarmConditionKeyType.TIME_SERIES,
              valueType: AlarmConditionValueType.NUMERIC,
              predicate: {
                operation: AlarmPredicateOperation.LESS_OR_EQUAL,
                value: { defaultValue: 35 },
              },
            },
          ],
        },
      },
    ],
  },
  {
    name: 'GPS Tracker',
    description: 'Vehicle/asset GPS tracking device',
    type: 'DEFAULT',
    transportType: DeviceTransportType.MQTT,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    alarmRules: [
      {
        id: 'alarm-2',
        alarmType: 'Speeding',
        enabled: true,
        severity: 'warning',
        propagate: true,
        propagateToOwner: true,
        propagateToTenant: false,
        condition: {
          spec: { type: AlarmConditionSpecType.SIMPLE },
          condition: [
            {
              key: 'speed',
              type: AlarmConditionKeyType.TIME_SERIES,
              valueType: AlarmConditionValueType.NUMERIC,
              predicate: {
                operation: AlarmPredicateOperation.GREATER,
                value: { defaultValue: 120 },
              },
            },
          ],
        },
      },
    ],
  },
  {
    name: 'Energy Meter',
    description: 'Electrical energy monitoring device',
    type: 'DEFAULT',
    transportType: DeviceTransportType.MQTT,
    provisionType: DeviceProvisionType.ALLOW_CREATE_NEW_DEVICES,
    alarmRules: [
      {
        id: 'alarm-3',
        alarmType: 'High Power Consumption',
        enabled: true,
        severity: 'warning',
        propagate: false,
        propagateToOwner: false,
        propagateToTenant: false,
        condition: {
          spec: { type: AlarmConditionSpecType.SIMPLE },
          condition: [
            {
              key: 'power',
              type: AlarmConditionKeyType.TIME_SERIES,
              valueType: AlarmConditionValueType.NUMERIC,
              predicate: {
                operation: AlarmPredicateOperation.GREATER,
                value: { defaultValue: 5000 },
              },
            },
          ],
        },
      },
    ],
  },
];

/**
 * Protocol defaults applied when a definition does not carry its own.
 * Mirrors DeviceProfilesService.getDefaultTransportConfig().
 */
function defaultTransportConfig(
  transportType: DeviceTransportType,
): DeviceTransportConfiguration | null {
  switch (transportType) {
    case DeviceTransportType.MQTT:
      return {
        mqtt: {
          deviceTelemetryTopic: 'v1/devices/me/telemetry',
          deviceAttributesTopic: 'v1/devices/me/attributes',
          deviceAttributesRequestTopic: 'v1/devices/me/attributes/request/+',
          deviceRpcRequestTopic: 'v1/devices/me/rpc/request/+',
          deviceRpcResponseTopic: 'v1/devices/me/rpc/response/',
          sendAckOnValidationException: false,
          devicePayloadType: DevicePayloadType.JSON,
        },
      };
    case DeviceTransportType.HTTP:
      return {
        http: {
          deviceTelemetryUrl: '/api/v1/{deviceToken}/telemetry',
          deviceAttributesUrl: '/api/v1/{deviceToken}/attributes',
          maxPayloadSize: 65536,
        },
      };
    case DeviceTransportType.COAP:
      return {
        coap: {
          deviceTelemetryPath: '/api/v1/{deviceToken}/telemetry',
          deviceAttributesPath: '/api/v1/{deviceToken}/attributes',
          powerMode: CoapPowerMode.DRX,
        },
      };
    default:
      return null;
  }
}

@Injectable()
export class DeviceProfileSeeder implements ISeeder {
  private readonly logger = new Logger(DeviceProfileSeeder.name);

  constructor(
    @InjectRepository(DeviceProfile)
    private readonly deviceProfileRepository: Repository<DeviceProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('Seeding device profiles...');

    const tenants = await this.tenantRepository.find();

    if (tenants.length === 0) {
      this.logger.warn('No tenants found. Please seed tenants first.');
      return;
    }

    let created = 0;
    let updated = 0;

    for (const tenant of tenants) {
      for (const definition of PROFILE_DEFINITIONS) {
        const transportConfiguration =
          definition.transportConfiguration ??
          defaultTransportConfig(definition.transportType);

        const existing = await this.deviceProfileRepository.findOne({
          where: { name: definition.name, tenantId: tenant.id },
        });

        if (existing) {
          existing.description = definition.description;
          existing.type = definition.type;
          existing.transportType = definition.transportType;
          existing.provisionType = definition.provisionType;
          existing.transportConfiguration = transportConfiguration;
          existing.alarmRules = definition.alarmRules ?? null;
          existing.default = definition.default ?? false;
          await this.deviceProfileRepository.save(existing);
          updated++;
          continue;
        }

        const profile = this.deviceProfileRepository.create({
          tenantId: tenant.id,
          name: definition.name,
          description: definition.description,
          type: definition.type,
          transportType: definition.transportType,
          provisionType: definition.provisionType,
          transportConfiguration,
          alarmRules: definition.alarmRules ?? null,
          default: definition.default ?? false,
        });

        await this.deviceProfileRepository.save(profile);
        created++;
      }
    }

    this.logger.log(
      `Device profile seeding complete - ${created} created, ${updated} updated ` +
        `(${PROFILE_DEFINITIONS.length} profiles x ${tenants.length} tenant(s)).`,
    );
  }
}
