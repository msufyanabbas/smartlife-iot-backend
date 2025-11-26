import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DeviceProfile,
  DeviceTransportType,
  DeviceProvisionType,
} from '@modules/profiles/entities/device-profile.entity';
import { Tenant } from '../../../modules/tenants/entities/tenant.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class DeviceProfileSeeder implements ISeeder {
  constructor(
    @InjectRepository(DeviceProfile)
    private readonly deviceProfileRepository: Repository<DeviceProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    // Fetch tenants for referential integrity
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (tenants.length === 0) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const deviceProfiles: Partial<DeviceProfile>[] = [
      // Default Temperature & Humidity Sensor Profile
      {
        name: 'Default Temperature Sensor',
        description:
          'Standard temperature and humidity sensor profile with MQTT transport',
        tenantId: tenants[0]?.id,
        default: true,
        type: 'temperature_sensor',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        profileData: {
          configuration: {
            type: 'DEFAULT',
          },
          alarms: [
            {
              id: 'high-temp-alarm',
              alarmType: 'High Temperature',
              createRules: {
                condition: {
                  spec: {
                    type: 'SIMPLE',
                  },
                  condition: [
                    {
                      key: { key: 'temperature', type: 'TIME_SERIES' },
                      valueType: 'NUMERIC',
                      predicate: {
                        operation: 'GREATER',
                        value: { defaultValue: 30 },
                      },
                    },
                  ],
                },
              },
              propagate: true,
            },
            {
              id: 'low-temp-alarm',
              alarmType: 'Low Temperature',
              createRules: {
                condition: {
                  spec: {
                    type: 'SIMPLE',
                  },
                  condition: [
                    {
                      key: { key: 'temperature', type: 'TIME_SERIES' },
                      valueType: 'NUMERIC',
                      predicate: {
                        operation: 'LESS',
                        value: { defaultValue: 10 },
                      },
                    },
                  ],
                },
              },
              propagate: true,
            },
          ],
        },
        telemetryConfig: {
          keys: [
            {
              key: 'temperature',
              label: 'Temperature',
              type: 'double',
              unit: '°C',
              decimals: 2,
            },
            {
              key: 'humidity',
              label: 'Humidity',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
          ],
        },
        attributesConfig: {
          server: ['firmwareVersion', 'model', 'manufacturer'],
          shared: ['updateInterval', 'alertThreshold'],
          client: ['location', 'description'],
        },
        alarmRules: [
          {
            id: 'critical-temp-alarm',
            alarmType: 'Critical Temperature',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'temperature', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER_OR_EQUAL',
                    value: 35,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
            propagateRelationTypes: ['Contains', 'Manages'],
          },
        ],
        provisionConfiguration: {
          type: 'ALLOW_CREATE_NEW_DEVICES',
          provisionDeviceKey: 'temp-sensor-key',
        },
        firmwareConfiguration: {
          firmwareUpdateStrategy: 'on_connect',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/temperature-sensor.png',
        additionalInfo: {
          category: 'Environmental Sensors',
          manufacturer: 'Generic',
          dataSheet: 'https://docs.example.com/temp-sensor.pdf',
        },
      },

      // Smart Gateway Profile
      {
        name: 'Smart Gateway',
        description: 'Edge gateway device profile for aggregating sensor data',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'gateway',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.CHECK_PRE_PROVISIONED,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/gateway/telemetry',
            deviceAttributesTopic: 'v1/gateway/attributes',
            sparkplug: true,
          },
        },
        profileData: {
          configuration: {
            type: 'DEFAULT',
          },
          alarms: [
            {
              id: 'gateway-offline',
              alarmType: 'Gateway Offline',
              createRules: {
                condition: {
                  spec: {
                    type: 'DURATION',
                  },
                  condition: [
                    {
                      key: { key: 'active', type: 'ATTRIBUTE' },
                      valueType: 'BOOLEAN',
                      predicate: {
                        operation: 'EQUAL',
                        value: { defaultValue: false },
                      },
                    },
                  ],
                },
              },
              propagate: true,
            },
          ],
        },
        telemetryConfig: {
          keys: [
            {
              key: 'cpuUsage',
              label: 'CPU Usage',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
            {
              key: 'memoryUsage',
              label: 'Memory Usage',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
            {
              key: 'connectedDevices',
              label: 'Connected Devices',
              type: 'long',
              decimals: 0,
            },
            {
              key: 'uptime',
              label: 'Uptime',
              type: 'long',
              unit: 'seconds',
              decimals: 0,
            },
          ],
        },
        attributesConfig: {
          server: ['firmwareVersion', 'maxConnections', 'protocol'],
          shared: ['autoUpdate', 'dataForwarding'],
          client: ['installedAt', 'location'],
        },
        alarmRules: [
          {
            id: 'high-cpu-alarm',
            alarmType: 'High CPU Usage',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'cpuUsage', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 80,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        provisionConfiguration: {
          type: 'CHECK_PRE_PROVISIONED_DEVICES',
          provisionDeviceKey: 'gateway-provision-key',
          provisionDeviceSecret: 'gateway-provision-secret',
        },
        defaultQueueName: 'HighPriority',
        image: 'https://cdn.example.com/profiles/gateway.png',
        additionalInfo: {
          category: 'Network Infrastructure',
          capabilities: [
            'edge-computing',
            'data-aggregation',
            'protocol-translation',
          ],
        },
      },

      // Pressure Sensor Profile (HTTP)
      {
        name: 'Industrial Pressure Sensor',
        description: 'High-precision pressure sensor with HTTP transport',
        tenantId: tenants[1]?.id || tenants[0]?.id,
        default: false,
        type: 'pressure_sensor',
        transportType: DeviceTransportType.HTTP,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          http: {
            baseUrl: 'https://api.example.com/devices',
            authMethod: 'bearer',
          },
        },
        profileData: {
          configuration: {
            type: 'DEFAULT',
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'pressure',
              label: 'Pressure',
              type: 'double',
              unit: 'PSI',
              decimals: 2,
            },
            {
              key: 'temperature',
              label: 'Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
          ],
        },
        attributesConfig: {
          server: ['calibrationDate', 'maxPressure', 'accuracy'],
          shared: ['sampleRate', 'unit'],
          client: ['installLocation', 'pipelineId'],
        },
        alarmRules: [
          {
            id: 'critical-pressure',
            alarmType: 'Critical Pressure',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'pressure', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 150,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
            propagateRelationTypes: ['Contains'],
          },
          {
            id: 'low-pressure',
            alarmType: 'Low Pressure Warning',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'pressure', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 20,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/pressure-sensor.png',
        additionalInfo: {
          category: 'Industrial Sensors',
          operatingRange: '0-200 PSI',
          certifications: ['ATEX', 'IECEx'],
        },
      },

      // GPS Tracker Profile (CoAP)
      {
        name: 'GPS Asset Tracker',
        description: 'Low-power GPS tracker with CoAP protocol',
        tenantId: tenants[1]?.id || tenants[0]?.id,
        default: false,
        type: 'gps_tracker',
        transportType: DeviceTransportType.COAP,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          coap: {
            powerMode: 'PSM',
            edrxCycle: 20480,
          },
        },
        profileData: {
          configuration: {
            type: 'DEFAULT',
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'latitude',
              label: 'Latitude',
              type: 'double',
              decimals: 7,
            },
            {
              key: 'longitude',
              label: 'Longitude',
              type: 'double',
              decimals: 7,
            },
            {
              key: 'speed',
              label: 'Speed',
              type: 'double',
              unit: 'km/h',
              decimals: 1,
            },
            {
              key: 'altitude',
              label: 'Altitude',
              type: 'double',
              unit: 'm',
              decimals: 1,
            },
            {
              key: 'battery',
              label: 'Battery Level',
              type: 'long',
              unit: '%',
              decimals: 0,
            },
          ],
        },
        attributesConfig: {
          server: ['imei', 'simCardNumber', 'firmwareVersion'],
          shared: ['reportInterval', 'geofenceRadius'],
          client: ['vehicleId', 'driverName'],
        },
        alarmRules: [
          {
            id: 'low-battery',
            alarmType: 'Low Battery',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'battery', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 20,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'speeding-alarm',
            alarmType: 'Speed Limit Exceeded',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'speed', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 120,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
        ],
        provisionConfiguration: {
          type: 'ALLOW_CREATE_NEW_DEVICES',
        },
        firmwareConfiguration: {
          firmwareUpdateStrategy: 'scheduled',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/gps-tracker.png',
        additionalInfo: {
          category: 'Asset Tracking',
          powerConsumption: 'Low',
          connectivity: '4G LTE',
        },
      },

      // Smart Energy Meter Profile
      {
        name: 'Smart Energy Meter',
        description: 'Three-phase energy meter with MQTT transport',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'energy_meter',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.CHECK_PRE_PROVISIONED,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'voltage',
              label: 'Voltage',
              type: 'double',
              unit: 'V',
              decimals: 2,
            },
            {
              key: 'current',
              label: 'Current',
              type: 'double',
              unit: 'A',
              decimals: 2,
            },
            {
              key: 'power',
              label: 'Active Power',
              type: 'double',
              unit: 'W',
              decimals: 2,
            },
            {
              key: 'energy',
              label: 'Energy Consumption',
              type: 'double',
              unit: 'kWh',
              decimals: 3,
            },
            {
              key: 'powerFactor',
              label: 'Power Factor',
              type: 'double',
              decimals: 3,
            },
            {
              key: 'frequency',
              label: 'Frequency',
              type: 'double',
              unit: 'Hz',
              decimals: 2,
            },
          ],
        },
        attributesConfig: {
          server: ['meterType', 'accuracy', 'ctRatio'],
          shared: ['tariffRate', 'demandPeriod'],
          client: ['installationDate', 'meterNumber'],
        },
        alarmRules: [
          {
            id: 'high-power-consumption',
            alarmType: 'High Power Consumption',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'power', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 10000,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'voltage-abnormal',
            alarmType: 'Voltage Abnormal',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'voltage', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'NOT_EQUAL',
                    value: 230,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
        ],
        provisionConfiguration: {
          type: 'CHECK_PRE_PROVISIONED_DEVICES',
          provisionDeviceKey: 'energy-meter-key',
          provisionDeviceSecret: 'energy-meter-secret',
        },
        defaultQueueName: 'HighPriority',
        image: 'https://cdn.example.com/profiles/energy-meter.png',
        additionalInfo: {
          category: 'Energy Management',
          standard: 'IEC 62052-11',
          phases: 3,
        },
      },

      // Water Quality Sensor Profile
      {
        name: 'Water Quality Sensor',
        description: 'Multi-parameter water quality monitoring sensor',
        tenantId: tenants[2]?.id || tenants[0]?.id,
        default: false,
        type: 'water_quality_sensor',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'ph',
              label: 'pH Level',
              type: 'double',
              decimals: 2,
            },
            {
              key: 'turbidity',
              label: 'Turbidity',
              type: 'double',
              unit: 'NTU',
              decimals: 2,
            },
            {
              key: 'dissolvedOxygen',
              label: 'Dissolved Oxygen',
              type: 'double',
              unit: 'mg/L',
              decimals: 2,
            },
            {
              key: 'conductivity',
              label: 'Conductivity',
              type: 'double',
              unit: 'μS/cm',
              decimals: 1,
            },
            {
              key: 'temperature',
              label: 'Water Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
          ],
        },
        attributesConfig: {
          server: ['calibrationDate', 'sensorLifespan'],
          shared: ['sampleInterval', 'alertEnabled'],
          client: ['deploymentLocation', 'waterBodyType'],
        },
        alarmRules: [
          {
            id: 'ph-out-of-range',
            alarmType: 'pH Out of Range',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'ph', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 6.5,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'high-turbidity',
            alarmType: 'High Turbidity',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'turbidity', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 5,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/water-quality.png',
        additionalInfo: {
          category: 'Environmental Monitoring',
          application: 'Water Quality Monitoring',
          compliance: ['EPA', 'WHO Guidelines'],
        },
      },

      // HVAC Controller Profile
      {
        name: 'HVAC Controller',
        description: 'Smart HVAC system controller with automation',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'hvac_controller',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.CHECK_PRE_PROVISIONED,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'temperature',
              label: 'Room Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
            {
              key: 'humidity',
              label: 'Humidity',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
            {
              key: 'mode',
              label: 'Operating Mode',
              type: 'string',
            },
            {
              key: 'fanSpeed',
              label: 'Fan Speed',
              type: 'long',
              unit: '%',
              decimals: 0,
            },
            {
              key: 'powerConsumption',
              label: 'Power Consumption',
              type: 'double',
              unit: 'W',
              decimals: 2,
            },
          ],
        },
        attributesConfig: {
          server: ['zones', 'capacity', 'efficiency'],
          shared: ['targetTemperature', 'schedule', 'ecoMode'],
          client: ['buildingArea', 'roomType'],
        },
        alarmRules: [
          {
            id: 'filter-replacement',
            alarmType: 'Filter Replacement Required',
            severity: 'MINOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'filterLife', type: 'ATTRIBUTE' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 10,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        provisionConfiguration: {
          type: 'CHECK_PRE_PROVISIONED_DEVICES',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/hvac.png',
        additionalInfo: {
          category: 'Building Automation',
          controlType: 'Smart Thermostat',
        },
      },

      // Security Camera Profile
      {
        name: 'IP Security Camera',
        description: 'High-definition IP camera with motion detection',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'security_camera',
        transportType: DeviceTransportType.HTTP,
        provisionType: DeviceProvisionType.CHECK_PRE_PROVISIONED,
        transportConfiguration: {
          http: {
            baseUrl: 'https://camera.example.com/api',
            authMethod: 'digest',
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'motionDetected',
              label: 'Motion Detected',
              type: 'boolean',
            },
            {
              key: 'recording',
              label: 'Recording Status',
              type: 'boolean',
            },
            {
              key: 'peopleCount',
              label: 'People Count',
              type: 'long',
              decimals: 0,
            },
            {
              key: 'storageUsed',
              label: 'Storage Used',
              type: 'double',
              unit: 'GB',
              decimals: 2,
            },
          ],
        },
        attributesConfig: {
          server: ['resolution', 'fps', 'codec'],
          shared: ['nightVision', 'motionSensitivity', 'recordingQuality'],
          client: ['installLocation', 'viewingAngle'],
        },
        alarmRules: [
          {
            id: 'motion-detected',
            alarmType: 'Motion Detected',
            severity: 'MINOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'motionDetected', type: 'TIME_SERIES' },
                  valueType: 'BOOLEAN',
                  predicate: {
                    operation: 'EQUAL',
                    value: true,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'storage-full',
            alarmType: 'Storage Almost Full',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'storageUsed', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 90,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/camera.png',
        additionalInfo: {
          category: 'Security',
          features: ['4K', 'Night Vision', 'Two-way Audio', 'Motion Detection'],
        },
      },

      // Soil Moisture Sensor (Agriculture)
      {
        name: 'Soil Moisture Sensor',
        description: 'Agricultural soil moisture and temperature sensor',
        tenantId: tenants[2]?.id || tenants[0]?.id,
        default: false,
        type: 'soil_sensor',
        transportType: DeviceTransportType.COAP,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          coap: {
            powerMode: 'PSM',
            edrxCycle: 81920,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'soilMoisture',
              label: 'Soil Moisture',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
            {
              key: 'soilTemperature',
              label: 'Soil Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
            {
              key: 'soilEC',
              label: 'Electrical Conductivity',
              type: 'double',
              unit: 'dS/m',
              decimals: 2,
            },
            {
              key: 'battery',
              label: 'Battery Level',
              type: 'long',
              unit: '%',
              decimals: 0,
            },
          ],
        },
        attributesConfig: {
          server: ['soilType', 'depth', 'calibrationData'],
          shared: ['irrigationThreshold', 'measurementInterval'],
          client: ['fieldId', 'cropType', 'plantingDate'],
        },
        alarmRules: [
          {
            id: 'low-moisture',
            alarmType: 'Low Soil Moisture',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'soilMoisture', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 30,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'critical-low-moisture',
            alarmType: 'Critical Low Moisture',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'soilMoisture', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'LESS',
                    value: 15,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
        ],
        firmwareConfiguration: {
          firmwareUpdateStrategy: 'scheduled',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/soil-sensor.png',
        additionalInfo: {
          category: 'Agriculture',
          application: 'Precision Farming',
          batteryLife: '2 years',
        },
      },

      // Generic SNMP Device Profile
      {
        name: 'SNMP Network Device',
        description: 'Generic SNMP-enabled network device profile',
        tenantId: tenants[1]?.id || tenants[0]?.id,
        default: false,
        type: 'network_device',
        transportType: DeviceTransportType.SNMP,
        provisionType: DeviceProvisionType.CHECK_PRE_PROVISIONED,
        transportConfiguration: {
          mqtt: undefined,
          http: undefined,
          coap: undefined,
        },
        telemetryConfig: {
          keys: [
            {
              key: 'sysUpTime',
              label: 'System Uptime',
              type: 'long',
              unit: 'seconds',
              decimals: 0,
            },
            {
              key: 'ifInOctets',
              label: 'Incoming Traffic',
              type: 'long',
              unit: 'bytes',
              decimals: 0,
            },
            {
              key: 'ifOutOctets',
              label: 'Outgoing Traffic',
              type: 'long',
              unit: 'bytes',
              decimals: 0,
            },
            {
              key: 'cpuUtilization',
              label: 'CPU Utilization',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
            {
              key: 'memoryUtilization',
              label: 'Memory Utilization',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
          ],
        },
        attributesConfig: {
          server: ['sysDescr', 'sysName', 'sysLocation'],
          shared: ['snmpVersion', 'community', 'pollInterval'],
          client: ['rackLocation', 'managementIP'],
        },
        alarmRules: [
          {
            id: 'high-cpu',
            alarmType: 'High CPU Utilization',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'cpuUtilization', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 80,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'device-down',
            alarmType: 'Device Not Responding',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'sysUpTime', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'EQUAL',
                    value: 0,
                  },
                },
              ],
              spec: {
                type: 'DURATION',
              },
            },
            propagate: true,
          },
        ],
        provisionConfiguration: {
          type: 'CHECK_PRE_PROVISIONED_DEVICES',
          provisionDeviceKey: 'snmp-device-key',
          provisionDeviceSecret: 'snmp-device-secret',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/network-device.png',
        additionalInfo: {
          category: 'Network Infrastructure',
          protocols: ['SNMPv2c', 'SNMPv3'],
          vendor: 'Generic',
        },
      },

      // Vibration Sensor Profile
      {
        name: 'Vibration Sensor',
        description:
          'Industrial vibration monitoring for predictive maintenance',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'vibration_sensor',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'vibrationX',
              label: 'Vibration X-Axis',
              type: 'double',
              unit: 'mm/s',
              decimals: 3,
            },
            {
              key: 'vibrationY',
              label: 'Vibration Y-Axis',
              type: 'double',
              unit: 'mm/s',
              decimals: 3,
            },
            {
              key: 'vibrationZ',
              label: 'Vibration Z-Axis',
              type: 'double',
              unit: 'mm/s',
              decimals: 3,
            },
            {
              key: 'temperature',
              label: 'Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
            {
              key: 'frequency',
              label: 'Frequency',
              type: 'double',
              unit: 'Hz',
              decimals: 2,
            },
          ],
        },
        attributesConfig: {
          server: ['sensorRange', 'sensitivity', 'samplingRate'],
          shared: ['alarmThreshold', 'maintenanceSchedule'],
          client: ['equipmentId', 'mountingPosition', 'machineType'],
        },
        alarmRules: [
          {
            id: 'high-vibration',
            alarmType: 'High Vibration Detected',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'vibrationX', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 10,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
            propagateRelationTypes: ['Contains', 'Manages'],
          },
          {
            id: 'critical-vibration',
            alarmType: 'Critical Vibration Level',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'vibrationX', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 20,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
            propagateRelationTypes: ['Contains', 'Manages'],
          },
        ],
        defaultQueueName: 'HighPriority',
        image: 'https://cdn.example.com/profiles/vibration-sensor.png',
        additionalInfo: {
          category: 'Predictive Maintenance',
          application: 'Rotating Machinery Monitoring',
          standard: 'ISO 10816',
        },
      },

      // Smart Parking Sensor
      {
        name: 'Smart Parking Sensor',
        description: 'Ultrasonic parking space occupancy sensor',
        tenantId: tenants[2]?.id || tenants[0]?.id,
        default: false,
        type: 'parking_sensor',
        transportType: DeviceTransportType.COAP,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          coap: {
            powerMode: 'DRX',
            edrxCycle: 10240,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'occupied',
              label: 'Space Occupied',
              type: 'boolean',
            },
            {
              key: 'distance',
              label: 'Distance',
              type: 'double',
              unit: 'cm',
              decimals: 1,
            },
            {
              key: 'battery',
              label: 'Battery Level',
              type: 'long',
              unit: '%',
              decimals: 0,
            },
            {
              key: 'signalStrength',
              label: 'Signal Strength',
              type: 'long',
              unit: 'dBm',
              decimals: 0,
            },
          ],
        },
        attributesConfig: {
          server: ['parkingSpaceId', 'zoneId', 'installationHeight'],
          shared: ['detectionThreshold', 'reportInterval'],
          client: ['locationDescription', 'spaceType'],
        },
        alarmRules: [
          {
            id: 'sensor-malfunction',
            alarmType: 'Sensor Malfunction',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'distance', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'EQUAL',
                    value: -1,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: false,
          },
        ],
        firmwareConfiguration: {
          firmwareUpdateStrategy: 'on_connect',
        },
        defaultQueueName: 'Main',
        image: 'https://cdn.example.com/profiles/parking-sensor.png',
        additionalInfo: {
          category: 'Smart City',
          application: 'Parking Management',
          batteryLife: '5 years',
        },
      },

      // Air Quality Monitor
      {
        name: 'Air Quality Monitor',
        description: 'Multi-gas air quality monitoring station',
        tenantId: tenants[0]?.id,
        default: false,
        type: 'air_quality_monitor',
        transportType: DeviceTransportType.MQTT,
        provisionType: DeviceProvisionType.ALLOW_CREATE_NEW,
        transportConfiguration: {
          mqtt: {
            deviceTelemetryTopic: 'v1/devices/me/telemetry',
            deviceAttributesTopic: 'v1/devices/me/attributes',
            sparkplug: false,
          },
        },
        telemetryConfig: {
          keys: [
            {
              key: 'pm25',
              label: 'PM2.5',
              type: 'double',
              unit: 'μg/m³',
              decimals: 1,
            },
            {
              key: 'pm10',
              label: 'PM10',
              type: 'double',
              unit: 'μg/m³',
              decimals: 1,
            },
            {
              key: 'co2',
              label: 'CO2',
              type: 'long',
              unit: 'ppm',
              decimals: 0,
            },
            {
              key: 'voc',
              label: 'VOC',
              type: 'double',
              unit: 'ppb',
              decimals: 1,
            },
            {
              key: 'no2',
              label: 'NO2',
              type: 'double',
              unit: 'ppb',
              decimals: 1,
            },
            {
              key: 'o3',
              label: 'Ozone',
              type: 'double',
              unit: 'ppb',
              decimals: 1,
            },
            {
              key: 'aqi',
              label: 'Air Quality Index',
              type: 'long',
              decimals: 0,
            },
            {
              key: 'temperature',
              label: 'Temperature',
              type: 'double',
              unit: '°C',
              decimals: 1,
            },
            {
              key: 'humidity',
              label: 'Humidity',
              type: 'double',
              unit: '%',
              decimals: 1,
            },
          ],
        },
        attributesConfig: {
          server: ['calibrationDate', 'sensorLifespan', 'accuracy'],
          shared: ['alertThresholds', 'reportingInterval'],
          client: ['installLocation', 'outdoorIndoor'],
        },
        alarmRules: [
          {
            id: 'poor-air-quality',
            alarmType: 'Poor Air Quality',
            severity: 'WARNING',
            createCondition: {
              condition: [
                {
                  key: { key: 'aqi', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 100,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'hazardous-air-quality',
            alarmType: 'Hazardous Air Quality',
            severity: 'CRITICAL',
            createCondition: {
              condition: [
                {
                  key: { key: 'aqi', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 300,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
          {
            id: 'high-co2',
            alarmType: 'High CO2 Level',
            severity: 'MAJOR',
            createCondition: {
              condition: [
                {
                  key: { key: 'co2', type: 'TIME_SERIES' },
                  valueType: 'NUMERIC',
                  predicate: {
                    operation: 'GREATER',
                    value: 1000,
                  },
                },
              ],
              spec: {
                type: 'SIMPLE',
              },
            },
            propagate: true,
          },
        ],
        defaultQueueName: 'HighPriority',
        image: 'https://cdn.example.com/profiles/air-quality.png',
        additionalInfo: {
          category: 'Environmental Monitoring',
          application: 'Indoor/Outdoor Air Quality',
          certifications: ['EPA Approved'],
        },
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const profileData of deviceProfiles) {
      const existing = await this.deviceProfileRepository.findOne({
        where: { name: profileData.name, tenantId: profileData.tenantId },
      });

      if (!existing) {
        const profile = this.deviceProfileRepository.create(profileData as any);
        await this.deviceProfileRepository.save(profile);
        console.log(
          `✅ Created device profile: ${profileData.name} (${profileData.transportType})`,
        );
        created++;
      } else {
        console.log(`⏭️  Device profile already exists: ${profileData.name}`);
        skipped++;
      }
    }

    console.log(`\n📋 Summary: ${created} created, ${skipped} skipped`);
    console.log('🎉 Device Profile seeding completed!');
  }
}
