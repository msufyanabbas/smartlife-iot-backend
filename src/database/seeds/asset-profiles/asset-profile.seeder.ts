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
    // Fetch tenants
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (tenants.length === 0) {
      console.log(
        '⚠️  No tenants found. Creating asset profiles without tenant associations.',
      );
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const generateId = (): string => {
      return 'rule-' + Math.random().toString(36).substring(2, 15);
    };

    const assetProfiles: Partial<AssetProfile>[] = [
      {
        name: 'Default Asset Profile',
        description: 'Default profile for general purpose assets',
        default: true,
        image: 'https://example.com/images/default-asset.png',
        attributesConfig: {
          server: ['latitude', 'longitude', 'address'],
          shared: ['model', 'manufacturer', 'serialNumber'],
        },
        defaultQueueName: 'Main',
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
          },
        ],
        customFields: [
          {
            key: 'location',
            label: 'Location',
            type: 'string',
            required: true,
          },
          {
            key: 'installationDate',
            label: 'Installation Date',
            type: 'date',
            required: false,
          },
        ],
        metadataSchema: {
          properties: {
            notes: {
              type: 'string',
              title: 'Notes',
              description: 'Additional notes about the asset',
            },
            status: {
              type: 'string',
              title: 'Status',
              required: true,
            },
          },
        },
        additionalInfo: {
          color: '#1976D2',
          icon: 'asset',
        },
      },
      {
        name: 'Industrial Equipment',
        description: 'Profile for industrial machinery and equipment',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/industrial-equipment.png',
        attributesConfig: {
          server: ['operatingHours', 'maintenanceSchedule', 'lastServiceDate'],
          shared: ['manufacturer', 'model', 'serialNumber', 'warrantyExpiry'],
        },
        defaultQueueName: 'Industrial',
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
          {
            id: generateId(),
            alarmType: 'Maintenance Due',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'daysSinceService',
                valueType: 'NUMERIC',
                value: 90,
                operation: 'GREATER',
              },
            },
            propagate: false,
          },
        ],
        customFields: [
          {
            key: 'manufacturer',
            label: 'Manufacturer',
            type: 'string',
            required: true,
          },
          {
            key: 'powerRating',
            label: 'Power Rating (kW)',
            type: 'number',
            required: true,
          },
          {
            key: 'operationalStatus',
            label: 'Operational Status',
            type: 'string',
            required: true,
            options: [
              'Operational',
              'Maintenance',
              'Offline',
              'Decommissioned',
            ],
          },
        ],
        metadataSchema: {
          properties: {
            certifications: {
              type: 'json',
              title: 'Certifications',
              description: 'Safety and quality certifications',
            },
            maintenanceHistory: {
              type: 'json',
              title: 'Maintenance History',
            },
          },
        },
        additionalInfo: {
          color: '#FF6F00',
          icon: 'factory',
          category: 'industrial',
        },
      },
      {
        name: 'Building Infrastructure',
        description: 'Profile for building systems and infrastructure',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/building.png',
        attributesConfig: {
          server: ['floor', 'room', 'zone', 'area'],
          shared: ['buildingName', 'address', 'capacity'],
        },
        defaultQueueName: 'Building',
        alarmRules: [
          {
            id: generateId(),
            alarmType: 'HVAC Failure',
            severity: 'MAJOR',
            createCondition: {
              condition: {
                key: 'hvacStatus',
                valueType: 'STRING',
                value: 'offline',
                operation: 'EQUAL',
              },
            },
            propagate: true,
          },
          {
            id: generateId(),
            alarmType: 'Air Quality Alert',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'co2Level',
                valueType: 'NUMERIC',
                value: 1000,
                operation: 'GREATER',
              },
            },
            propagate: false,
          },
        ],
        customFields: [
          {
            key: 'buildingName',
            label: 'Building Name',
            type: 'string',
            required: true,
          },
          {
            key: 'floor',
            label: 'Floor',
            type: 'number',
            required: true,
          },
          {
            key: 'systemType',
            label: 'System Type',
            type: 'string',
            required: true,
            options: ['HVAC', 'Electrical', 'Plumbing', 'Security', 'Elevator'],
          },
        ],
        metadataSchema: {
          properties: {
            blueprintReference: {
              type: 'string',
              title: 'Blueprint Reference',
            },
            installationYear: {
              type: 'number',
              title: 'Installation Year',
              required: true,
            },
          },
        },
        additionalInfo: {
          color: '#2E7D32',
          icon: 'building',
          category: 'infrastructure',
        },
      },
      {
        name: 'IoT Sensors',
        description: 'Profile for IoT sensor devices',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/iot-sensor.png',
        attributesConfig: {
          server: [
            'batteryLevel',
            'signalStrength',
            'lastSeen',
            'firmwareVersion',
          ],
          shared: ['sensorType', 'manufacturer', 'model'],
        },
        defaultQueueName: 'IoT',
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
          },
          {
            id: generateId(),
            alarmType: 'Signal Strength Low',
            severity: 'MINOR',
            createCondition: {
              condition: {
                key: 'signalStrength',
                valueType: 'NUMERIC',
                value: -80,
                operation: 'LESS',
              },
            },
            propagate: false,
          },
        ],
        customFields: [
          {
            key: 'sensorType',
            label: 'Sensor Type',
            type: 'string',
            required: true,
            options: [
              'Temperature',
              'Humidity',
              'Pressure',
              'Motion',
              'Light',
              'Air Quality',
            ],
          },
          {
            key: 'calibrationDate',
            label: 'Last Calibration Date',
            type: 'date',
            required: false,
          },
          {
            key: 'accuracy',
            label: 'Accuracy (%)',
            type: 'number',
            required: false,
          },
        ],
        metadataSchema: {
          properties: {
            communicationProtocol: {
              type: 'string',
              title: 'Communication Protocol',
              description: 'Network protocol used (MQTT, HTTP, CoAP, etc.)',
            },
            samplingRate: {
              type: 'number',
              title: 'Sampling Rate (seconds)',
              required: true,
            },
          },
        },
        additionalInfo: {
          color: '#9C27B0',
          icon: 'sensors',
          category: 'iot',
        },
      },
      {
        name: 'Vehicle Fleet',
        description: 'Profile for fleet management and vehicle tracking',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/vehicle.png',
        attributesConfig: {
          server: ['latitude', 'longitude', 'speed', 'heading', 'odometer'],
          shared: [
            'vehicleType',
            'make',
            'model',
            'year',
            'licensePlate',
            'vin',
          ],
        },
        defaultQueueName: 'Fleet',
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
          },
          {
            id: generateId(),
            alarmType: 'Maintenance Required',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'odometerSinceService',
                valueType: 'NUMERIC',
                value: 10000,
                operation: 'GREATER',
              },
            },
            propagate: false,
          },
          {
            id: generateId(),
            alarmType: 'Geofence Violation',
            severity: 'CRITICAL',
            createCondition: {
              condition: {
                key: 'outsideGeofence',
                valueType: 'BOOLEAN',
                value: true,
                operation: 'EQUAL',
              },
            },
            propagate: true,
          },
        ],
        customFields: [
          {
            key: 'vehicleType',
            label: 'Vehicle Type',
            type: 'string',
            required: true,
            options: ['Car', 'Truck', 'Van', 'Motorcycle', 'Bus'],
          },
          {
            key: 'licensePlate',
            label: 'License Plate',
            type: 'string',
            required: true,
          },
          {
            key: 'fuelType',
            label: 'Fuel Type',
            type: 'string',
            required: true,
            options: ['Gasoline', 'Diesel', 'Electric', 'Hybrid'],
          },
          {
            key: 'capacity',
            label: 'Passenger Capacity',
            type: 'number',
            required: false,
          },
        ],
        metadataSchema: {
          properties: {
            driverAssigned: {
              type: 'string',
              title: 'Assigned Driver',
            },
            insuranceExpiry: {
              type: 'string',
              title: 'Insurance Expiry Date',
              required: true,
            },
            registrationNumber: {
              type: 'string',
              title: 'Registration Number',
              required: true,
            },
          },
        },
        additionalInfo: {
          color: '#F44336',
          icon: 'directions_car',
          category: 'fleet',
        },
      },
      {
        name: 'Energy Management',
        description: 'Profile for energy monitoring and management systems',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/energy.png',
        attributesConfig: {
          server: [
            'powerConsumption',
            'voltage',
            'current',
            'powerFactor',
            'frequency',
          ],
          shared: ['meterType', 'ratedCapacity', 'location'],
        },
        defaultQueueName: 'Energy',
        alarmRules: [
          {
            id: generateId(),
            alarmType: 'High Power Consumption',
            severity: 'MAJOR',
            createCondition: {
              condition: {
                key: 'powerConsumption',
                valueType: 'NUMERIC',
                value: 1000,
                operation: 'GREATER',
              },
            },
            propagate: true,
          },
          {
            id: generateId(),
            alarmType: 'Low Power Factor',
            severity: 'WARNING',
            createCondition: {
              condition: {
                key: 'powerFactor',
                valueType: 'NUMERIC',
                value: 0.85,
                operation: 'LESS',
              },
            },
            propagate: false,
          },
          {
            id: generateId(),
            alarmType: 'Voltage Anomaly',
            severity: 'CRITICAL',
            createCondition: {
              condition: {
                key: 'voltage',
                valueType: 'NUMERIC',
                value: 250,
                operation: 'GREATER',
              },
            },
            propagate: true,
          },
        ],
        customFields: [
          {
            key: 'meterType',
            label: 'Meter Type',
            type: 'string',
            required: true,
            options: ['Electric', 'Gas', 'Water', 'Solar'],
          },
          {
            key: 'ratedCapacity',
            label: 'Rated Capacity (kW)',
            type: 'number',
            required: true,
          },
          {
            key: 'tariffPlan',
            label: 'Tariff Plan',
            type: 'string',
            required: false,
          },
        ],
        metadataSchema: {
          properties: {
            utilityProvider: {
              type: 'string',
              title: 'Utility Provider',
            },
            accountNumber: {
              type: 'string',
              title: 'Account Number',
            },
            billingCycle: {
              type: 'string',
              title: 'Billing Cycle',
            },
          },
        },
        additionalInfo: {
          color: '#FFC107',
          icon: 'bolt',
          category: 'energy',
        },
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const profileData of assetProfiles) {
      const existing = await this.assetProfileRepository.findOne({
        where: { name: profileData.name },
      });

      if (!existing) {
        const profile = this.assetProfileRepository.create(profileData);
        await this.assetProfileRepository.save(profile);
        console.log(`✅ Created asset profile: ${profileData.name}`);
        created++;
      } else {
        console.log(`⏭️  Asset profile already exists: ${profileData.name}`);
        skipped++;
      }
    }

    console.log(`\n📊 Summary: ${created} created, ${skipped} skipped`);
    console.log('🎉 Asset profile seeding completed!');
  }
}
