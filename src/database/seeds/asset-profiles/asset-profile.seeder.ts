// src/database/seeders/asset-profile.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, AssetProfile } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AssetProfileSeeder implements ISeeder {
  constructor(
    @InjectRepository(AssetProfile)
    private readonly assetProfileRepository: Repository<AssetProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    console.log('🏢 Seeding asset profiles...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const generateId = (): string => {
      return 'rule-' + Math.random().toString(36).substring(2, 15);
    };

    const profilesData: Partial<AssetProfile>[] = [
      // 1. Default Asset Profile (System-wide, no tenantId)
      {
        tenantId: tenant.id,
        name: 'Default Asset Profile',
        description: 'Default profile for general purpose assets',
        default: true,
        image: 'https://example.com/images/default-asset.png',

        attributesSchema: {
          required: [
            {
              key: 'location',
              label: 'Location',
              type: 'string',
            },
          ],
          optional: [
            {
              key: 'installationDate',
              label: 'Installation Date',
              type: 'date',
            },
          ],
        },

        alarmRules: [
          {
            id: generateId(),
            alarmType: 'General Alarm',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'temperature',
                valueType: 'NUMERIC',
                value: 50,
                operation: 'GREATER',
              },
            },
            clearCondition: {
              condition: {
                key: 'temperature',
                valueType: 'NUMERIC',
                value: 45,
                operation: 'LESS',
              },
            },
            propagate: false,
            propagateToParent: false,
            propagateToChildren: false,
          },
        ],

        locationConfig: {
          required: true,
          requireCoordinates: true,
          requireAddress: false,
          allowManualEntry: true,
          defaultZoom: 15,
        },

        deviceConfig: {
          allowDevices: true,
        },

        mapConfig: {
          icon: 'asset',
          iconColor: '#1976D2',
          markerType: 'pin',
          showLabel: true,
        },

        additionalInfo: {
          color: '#1976D2',
          icon: 'asset',
        },
      },

      // 2. Smart Building Profile
      {
        tenantId: tenant.id,
        name: 'Smart Building',
        description: 'Profile for smart buildings with HVAC and automation',
        default: false,
        image: 'https://example.com/images/building.png',

        attributesSchema: {
          required: [
            {
              key: 'buildingName',
              label: 'Building Name',
              type: 'string',
            },
            {
              key: 'totalFloors',
              label: 'Total Floors',
              type: 'number',
              validation: {
                min: 1,
                max: 200,
              },
            },
          ],
          optional: [
            {
              key: 'occupancyLimit',
              label: 'Occupancy Limit',
              type: 'number',
            },
          ],
        },

        calculatedFields: [
          {
            id: 'calc1',
            name: 'energyCostPerSqm',
            type: 'number',
            expression: 'totalEnergyConsumption / totalArea',
            description: 'Energy cost per square meter',
            unit: 'SAR/sqm',
            decimalPlaces: 2,
          },
        ],

        alarmRules: [
          {
            id: generateId(),
            alarmType: 'High Temperature',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'temperature',
                valueType: 'NUMERIC',
                value: 28,
                operation: 'GREATER',
              },
            },
            propagate: true,
            propagateToParent: true,
          },
          {
            id: generateId(),
            alarmType: 'Fire Alarm',
            severity: 'CRITICAL',
            createCondition: {
              condition: {
                key: 'fireDetected',
                valueType: 'BOOLEAN',
                value: true,
                operation: 'EQUAL',
              },
            },
            propagate: true,
            propagateToParent: true,
            propagateToChildren: true,
          },
        ],

        hierarchyConfig: {
          allowChildren: true,
          allowedChildTypes: ['floor', 'zone', 'room'],
          requireParent: false,
          maxDepth: 3,
        },

        locationConfig: {
          required: true,
          requireCoordinates: true,
          requireAddress: true,
          defaultZoom: 18,
        },

        deviceConfig: {
          allowDevices: true,
          maxDevices: 100,
          inheritDevicesToChildren: true,
        },

        mapConfig: {
          icon: 'business',
          iconColor: '#2196F3',
          markerType: 'pin',
          showLabel: true,
          clusterThreshold: 12,
        },

        additionalInfo: {
          color: '#2196F3',
          icon: 'business',
          category: 'building',
        },
      },

      // 3. Industrial Equipment
      {
        tenantId: tenant.id,
        name: 'Industrial Equipment',
        description: 'Profile for industrial machinery and equipment',
        default: false,
        image: 'https://example.com/images/industrial.png',

        attributesSchema: {
          required: [
            {
              key: 'manufacturer',
              label: 'Manufacturer',
              type: 'string',
            },
            {
              key: 'powerRating',
              label: 'Power Rating (kW)',
              type: 'number',
              validation: {
                min: 0,
                max: 10000,
              },
            },
          ],
          optional: [],
        },

        alarmRules: [
          {
            id: generateId(),
            alarmType: 'High Temperature',
            severity: 'CRITICAL',
            createCondition: {
              condition: {
                key: 'temperature',
                valueType: 'NUMERIC',
                value: 85,
                operation: 'GREATER',
              },
            },
            clearCondition: {
              condition: {
                key: 'temperature',
                valueType: 'NUMERIC',
                value: 75,
                operation: 'LESS',
              },
            },
            propagate: true,
            propagateToParent: true,
          },
          {
            id: generateId(),
            alarmType: 'Vibration Alert',
            severity: 'MAJOR',
            createCondition: {
              condition: {
                key: 'vibration',
                valueType: 'NUMERIC',
                value: 100,
                operation: 'GREATER',
              },
            },
            propagate: false,
          },
        ],

        hierarchyConfig: {
          allowChildren: false,
          requireParent: false,
        },

        locationConfig: {
          required: true,
          requireCoordinates: true,
        },

        deviceConfig: {
          allowDevices: true,
          maxDevices: 20,
        },

        mapConfig: {
          icon: 'precision_manufacturing',
          iconColor: '#FF6F00',
          markerType: 'circle',
          showLabel: true,
        },

        additionalInfo: {
          color: '#FF6F00',
          icon: 'factory',
          category: 'industrial',
        },
      },

      // 4. Vehicle Fleet
      {
        tenantId: tenant.id,
        name: 'Vehicle Fleet',
        description: 'Profile for fleet management and vehicle tracking',
        default: false,
        image: 'https://example.com/images/vehicle.png',

        attributesSchema: {
          required: [
            {
              key: 'vehicleType',
              label: 'Vehicle Type',
              type: 'select',
              options: [
                { label: 'Car', value: 'car' },
                { label: 'Truck', value: 'truck' },
                { label: 'Van', value: 'van' },
                { label: 'Motorcycle', value: 'motorcycle' },
                { label: 'Bus', value: 'bus' },
              ],
            },
            {
              key: 'licensePlate',
              label: 'License Plate',
              type: 'string',
              validation: {
                pattern: '^[A-Z0-9]{1,10}$',
              },
            },
          ],
          optional: [
            {
              key: 'capacity',
              label: 'Passenger Capacity',
              type: 'number',
            },
          ],
        },

        calculatedFields: [
          {
            id: 'calc1',
            name: 'fuelEfficiency',
            type: 'number',
            expression: 'distanceTraveled / fuelConsumed',
            description: 'Fuel efficiency',
            unit: 'km/L',
            decimalPlaces: 2,
          },
        ],

        alarmRules: [
          {
            id: generateId(),
            alarmType: 'Speeding',
            severity: 'MAJOR',
            createCondition: {
              condition: {
                key: 'speed',
                valueType: 'NUMERIC',
                value: 120,
                operation: 'GREATER',
              },
            },
            propagate: true,
            propagateToParent: true,
          },
          {
            id: generateId(),
            alarmType: 'Low Fuel',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'fuelLevel',
                valueType: 'NUMERIC',
                value: 20,
                operation: 'LESS',
              },
            },
            propagate: false,
          },
        ],

        hierarchyConfig: {
          allowChildren: false,
          requireParent: false,
        },

        locationConfig: {
          required: true,
          requireCoordinates: true,
          requireAddress: false,
          defaultZoom: 15,
        },

        deviceConfig: {
          allowDevices: true,
          maxDevices: 5,
          requireDevices: true,
          minDevices: 1,
        },

        mapConfig: {
          icon: 'directions_car',
          iconColor: '#F44336',
          markerType: 'custom',
          showLabel: true,
        },

        additionalInfo: {
          color: '#F44336',
          icon: 'directions_car',
          category: 'fleet',
        },
      },

      // 5. IoT Sensors
      {
        tenantId: tenant.id,
        name: 'IoT Sensors',
        description: 'Profile for IoT sensor devices',
        default: false,
        image: 'https://example.com/images/sensor.png',

        attributesSchema: {
          required: [
            {
              key: 'sensorType',
              label: 'Sensor Type',
              type: 'select',
              options: [
                { label: 'Temperature', value: 'temperature' },
                { label: 'Humidity', value: 'humidity' },
                { label: 'Pressure', value: 'pressure' },
                { label: 'Motion', value: 'motion' },
                { label: 'Light', value: 'light' },
                { label: 'Air Quality', value: 'air_quality' },
              ],
            },
          ],
          optional: [
            {
              key: 'calibrationDate',
              label: 'Calibration Date',
              type: 'date',
            },
            {
              key: 'accuracy',
              label: 'Accuracy (%)',
              type: 'number',
            },
          ],
        },

        alarmRules: [
          {
            id: generateId(),
            alarmType: 'Low Battery',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'batteryLevel',
                valueType: 'NUMERIC',
                value: 20,
                operation: 'LESS',
              },
            },
            propagate: false,
          },
          {
            id: generateId(),
            alarmType: 'Device Offline',
            severity: 'MAJOR',
            createCondition: {
              condition: {
                key: 'minutesSinceLastSeen',
                valueType: 'NUMERIC',
                value: 30,
                operation: 'GREATER',
              },
            },
            propagate: true,
            propagateToParent: true,
          },
        ],

        locationConfig: {
          required: true,
          requireCoordinates: true,
        },

        deviceConfig: {
          allowDevices: false,
        },

        mapConfig: {
          icon: 'sensors',
          iconColor: '#9C27B0',
          markerType: 'circle',
          showLabel: false,
        },

        additionalInfo: {
          color: '#9C27B0',
          icon: 'sensors',
          category: 'iot',
        },
      },
    ];

    for (const profileData of profilesData) {
      const existing = await this.assetProfileRepository.findOne({
        where: {
          name: profileData.name,
          tenantId: profileData.tenantId,
        },
      });

      if (!existing) {
        const profile = this.assetProfileRepository.create(profileData);
        await this.assetProfileRepository.save(profile);
        console.log(`✅ Created asset profile: ${profileData.name}`);
      } else {
        console.log(`⏭️  Asset profile already exists: ${profileData.name}`);
      }
    }

    console.log('🎉 Asset profile seeding completed! (5 profiles created)');
  }
}