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

        // These properties exist in entity but aren't decorated - they'll be stored
        attributesConfig: {
          server: ['latitude', 'longitude', 'address'],
          shared: ['model', 'manufacturer', 'serialNumber'],
        },

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

        serverAttributeKeys: ['latitude', 'longitude', 'address'],
        sharedAttributeKeys: ['model', 'manufacturer', 'serialNumber'],

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
      {
        name: 'Smart Building Profile',
        description: 'Profile for smart buildings with HVAC and automation',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/building.png',

        attributesConfig: {
          server: ['floor', 'room', 'zone', 'area'],
          shared: ['buildingName', 'address', 'capacity'],
        },

        customFields: [
          {
            key: 'buildingName',
            label: 'Building Name',
            type: 'string',
            required: true,
          },
          {
            key: 'totalFloors',
            label: 'Total Floors',
            type: 'number',
            required: true,
          },
          {
            key: 'buildingType',
            label: 'Building Type',
            type: 'string',
            required: true,
            options: ['Commercial', 'Residential', 'Industrial', 'Mixed-Use'],
          },
        ],

        metadataSchema: {
          properties: {
            constructionYear: {
              type: 'number',
              title: 'Construction Year',
            },
            totalArea: {
              type: 'number',
              title: 'Total Area (sqm)',
              required: true,
            },
          },
        },

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

        serverAttributeKeys: ['hvacStatus', 'energyConsumption', 'occupancy'],
        sharedAttributeKeys: ['buildingName', 'address', 'totalFloors'],

        defaultQueueName: 'Main',

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
      {
        name: 'Industrial Equipment',
        description: 'Profile for industrial machinery and equipment',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/industrial.png',

        attributesConfig: {
          server: ['operatingHours', 'maintenanceSchedule', 'lastServiceDate'],
          shared: ['manufacturer', 'model', 'serialNumber', 'warrantyExpiry'],
        },

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
            options: ['Operational', 'Maintenance', 'Offline', 'Decommissioned'],
          },
        ],

        metadataSchema: {
          properties: {
            certifications: {
              type: 'json',
              title: 'Safety Certifications',
            },
            maintenanceHistory: {
              type: 'json',
              title: 'Maintenance History',
            },
          },
        },

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

        serverAttributeKeys: ['operatingHours', 'temperature', 'vibration'],
        sharedAttributeKeys: ['manufacturer', 'model', 'serialNumber'],

        defaultQueueName: 'Main',

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
      {
        name: 'Vehicle Fleet',
        description: 'Profile for fleet management and vehicle tracking',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/vehicle.png',

        attributesConfig: {
          server: ['latitude', 'longitude', 'speed', 'heading', 'odometer'],
          shared: ['vehicleType', 'make', 'model', 'year', 'licensePlate', 'vin'],
        },

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
        ],

        metadataSchema: {
          properties: {
            driverAssigned: {
              type: 'string',
              title: 'Assigned Driver',
            },
            insuranceExpiry: {
              type: 'string',
              title: 'Insurance Expiry',
              required: true,
            },
          },
        },

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

        serverAttributeKeys: ['latitude', 'longitude', 'speed', 'fuelLevel'],
        sharedAttributeKeys: ['vehicleType', 'licensePlate', 'make', 'model'],

        defaultQueueName: 'Main',

        queueConfig: {
          submitStrategy: 'SEQUENTIAL_BY_ORIGINATOR',
          processingStrategy: 'RETRY_FAILED_AND_TIMED_OUT',
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
            propagateToParent: true,
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
      {
        name: 'IoT Sensors',
        description: 'Profile for IoT sensor devices',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/sensor.png',

        attributesConfig: {
          server: ['batteryLevel', 'signalStrength', 'lastSeen', 'firmwareVersion'],
          shared: ['sensorType', 'manufacturer', 'model'],
        },

        customFields: [
          {
            key: 'sensorType',
            label: 'Sensor Type',
            type: 'string',
            required: true,
            options: ['Temperature', 'Humidity', 'Pressure', 'Motion', 'Light', 'Air Quality'],
          },
          {
            key: 'calibrationDate',
            label: 'Last Calibration',
            type: 'date',
            required: false,
          },
        ],

        metadataSchema: {
          properties: {
            communicationProtocol: {
              type: 'string',
              title: 'Protocol',
              description: 'MQTT, HTTP, CoAP, etc.',
            },
            samplingRate: {
              type: 'number',
              title: 'Sampling Rate (seconds)',
              required: true,
            },
          },
        },

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

        serverAttributeKeys: ['batteryLevel', 'signalStrength', 'lastSeen'],
        sharedAttributeKeys: ['sensorType', 'manufacturer'],

        defaultQueueName: 'Main',

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
      {
        name: 'Energy Management',
        description: 'Profile for energy monitoring systems',
        tenantId: getRandomItem(tenants)?.id,
        default: false,
        image: 'https://example.com/images/energy.png',

        attributesConfig: {
          server: ['powerConsumption', 'voltage', 'current', 'powerFactor'],
          shared: ['meterType', 'ratedCapacity', 'location'],
        },

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
          },
        },

        attributesSchema: {
          required: [
            {
              key: 'meterType',
              label: 'Meter Type',
              type: 'select',
              options: [
                { label: 'Electric', value: 'electric' },
                { label: 'Gas', value: 'gas' },
                { label: 'Water', value: 'water' },
                { label: 'Solar', value: 'solar' },
              ],
            },
            {
              key: 'ratedCapacity',
              label: 'Rated Capacity (kW)',
              type: 'number',
              validation: {
                min: 0,
              },
            },
          ],
          optional: [
            {
              key: 'tariffPlan',
              label: 'Tariff Plan',
              type: 'string',
            },
          ],
        },

        serverAttributeKeys: ['powerConsumption', 'voltage', 'current'],
        sharedAttributeKeys: ['meterType', 'ratedCapacity'],

        defaultQueueName: 'Main',

        calculatedFields: [
          {
            id: 'calc1',
            name: 'totalCost',
            type: 'number',
            expression: 'powerConsumption * tariffRate',
            description: 'Total energy cost',
            unit: 'SAR',
            decimalPlaces: 2,
          },
        ],

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
            propagateToParent: true,
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
            propagateToParent: true,
          },
        ],

        locationConfig: {
          required: true,
          requireCoordinates: true,
        },

        deviceConfig: {
          allowDevices: true,
        },

        mapConfig: {
          icon: 'bolt',
          iconColor: '#FFC107',
          markerType: 'pin',
          showLabel: true,
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