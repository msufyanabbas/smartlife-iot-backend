import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Attribute,
  Device,
  Asset,
  User,
  Tenant,
} from '@modules/index.entities';
import {
  AttributeScope,
  DataType,
} from '@modules/attributes/entities/attribute.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AttributeSeeder implements ISeeder {
  constructor(
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    // Fetch entities to attach attributes to
    const devices = await this.deviceRepository.find({ take: 10 });
    const assets = await this.assetRepository.find({ take: 10 });
    const users = await this.userRepository.find({ take: 5 });
    const tenants = await this.tenantRepository.find({ take: 3 });

    if (devices.length === 0 && assets.length === 0) {
      console.log(
        '⚠️  No devices or assets found. Please seed devices/assets first.',
      );
      return;
    }

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const getCurrentTimestamp = (): number => {
      return Date.now();
    };

    const getRandomTimestamp = (daysAgo: number): number => {
      const now = Date.now();
      const offset = daysAgo * 24 * 60 * 60 * 1000;
      return now - Math.floor(Math.random() * offset);
    };

    const attributes: Partial<Attribute>[] = [];

    // Device Attributes
    for (const device of devices) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      // Server-side attributes (internal system data)
      const serverAttributes: Array<{
        attributeKey: string;
        dataType: DataType;
        scope: AttributeScope;
        stringValue?: string;
        numberValue?: number;
        booleanValue?: boolean;
        jsonValue?: any;
      }> = [
        {
          attributeKey: 'ipAddress',
          dataType: DataType.STRING,
          stringValue: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'firmwareVersion',
          dataType: DataType.STRING,
          stringValue: `v${Math.floor(Math.random() * 3) + 1}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}`,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'lastSeen',
          dataType: DataType.NUMBER,
          numberValue: getRandomTimestamp(1),
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'uptime',
          dataType: DataType.NUMBER,
          numberValue: Math.floor(Math.random() * 1000000),
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'isOnline',
          dataType: DataType.BOOLEAN,
          booleanValue: Math.random() > 0.2,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'configuration',
          dataType: DataType.JSON,
          jsonValue: {
            reportingInterval: 60,
            retryAttempts: 3,
            timeout: 30,
            protocol: 'MQTT',
          },
          scope: AttributeScope.SERVER,
        },
      ];

      // Shared attributes (visible to both server and client)
      const sharedAttributes: Array<{
        attributeKey: string;
        dataType: DataType;
        scope: AttributeScope;
        stringValue?: string;
        numberValue?: number;
        booleanValue?: boolean;
        jsonValue?: any;
      }> = [
        {
          attributeKey: 'latitude',
          dataType: DataType.NUMBER,
          numberValue: 24.7136 + (Math.random() - 0.5) * 0.1,
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'longitude',
          dataType: DataType.NUMBER,
          numberValue: 46.6753 + (Math.random() - 0.5) * 0.1,
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'location',
          dataType: DataType.STRING,
          stringValue: [
            'Building A',
            'Building B',
            'Warehouse',
            'Factory Floor',
          ][Math.floor(Math.random() * 4)],
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'manufacturer',
          dataType: DataType.STRING,
          stringValue: ['Siemens', 'Schneider Electric', 'ABB', 'Honeywell'][
            Math.floor(Math.random() * 4)
          ],
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'model',
          dataType: DataType.STRING,
          stringValue: `Model-${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${Math.floor(Math.random() * 1000)}`,
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'serialNumber',
          dataType: DataType.STRING,
          stringValue: `SN${Math.random().toString(36).substring(2, 15).toUpperCase()}`,
          scope: AttributeScope.SHARED,
        },
      ];

      // Client-side attributes (set by device/client)
      const clientAttributes: Array<{
        attributeKey: string;
        dataType: DataType;
        scope: AttributeScope;
        stringValue?: string;
        numberValue?: number;
        booleanValue?: boolean;
        jsonValue?: any;
      }> = [
        {
          attributeKey: 'batteryLevel',
          dataType: DataType.NUMBER,
          numberValue: Math.floor(Math.random() * 100),
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'signalStrength',
          dataType: DataType.NUMBER,
          numberValue: -50 - Math.floor(Math.random() * 50),
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'temperature',
          dataType: DataType.NUMBER,
          numberValue: 20 + Math.random() * 30,
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'humidity',
          dataType: DataType.NUMBER,
          numberValue: 30 + Math.random() * 50,
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'sensorStatus',
          dataType: DataType.JSON,
          jsonValue: {
            active: true,
            lastCalibration: new Date(getRandomTimestamp(30)).toISOString(),
            errorCount: Math.floor(Math.random() * 5),
          },
          scope: AttributeScope.CLIENT,
        },
      ];

      const allDeviceAttributes = [
        ...serverAttributes,
        ...sharedAttributes,
        ...clientAttributes.slice(0, 3), // Add only some client attributes
      ];

      allDeviceAttributes.forEach((attr) => {
        attributes.push({
          entityType: 'Device',
          entityId: device.id,
          attributeKey: attr.attributeKey,
          scope: attr.scope,
          dataType: attr.dataType,
          stringValue: attr.stringValue,
          numberValue: attr.numberValue,
          booleanValue: attr.booleanValue,
          jsonValue: attr.jsonValue,
          lastUpdateTs: getRandomTimestamp(7),
          userId: user?.id || users[0]?.id,
          tenantId: tenant?.id || device.tenantId,
        });
      });
    }

    // Asset Attributes
    for (const asset of assets) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      const assetAttributes: Array<{
        attributeKey: string;
        dataType: DataType;
        scope: AttributeScope;
        stringValue?: string;
        numberValue?: number;
        booleanValue?: boolean;
        jsonValue?: any;
      }> = [
        // Server attributes
        {
          attributeKey: 'installationDate',
          dataType: DataType.NUMBER,
          numberValue: getRandomTimestamp(365),
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'warrantyExpiry',
          dataType: DataType.NUMBER,
          numberValue: Date.now() + 365 * 24 * 60 * 60 * 1000,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'purchasePrice',
          dataType: DataType.NUMBER,
          numberValue: 10000 + Math.random() * 90000,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'isActive',
          dataType: DataType.BOOLEAN,
          booleanValue: true,
          scope: AttributeScope.SERVER,
        },
        {
          attributeKey: 'maintenanceSchedule',
          dataType: DataType.JSON,
          jsonValue: {
            frequency: 'quarterly',
            lastService: new Date(getRandomTimestamp(90)).toISOString(),
            nextService: new Date(
              Date.now() + 90 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
          scope: AttributeScope.SERVER,
        },
        // Shared attributes
        {
          attributeKey: 'assetTag',
          dataType: DataType.STRING,
          stringValue: `ASSET-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'category',
          dataType: DataType.STRING,
          stringValue: ['Equipment', 'Vehicle', 'Infrastructure', 'Building'][
            Math.floor(Math.random() * 4)
          ],
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'condition',
          dataType: DataType.STRING,
          stringValue: ['Excellent', 'Good', 'Fair', 'Poor'][
            Math.floor(Math.random() * 4)
          ],
          scope: AttributeScope.SHARED,
        },
        {
          attributeKey: 'specifications',
          dataType: DataType.JSON,
          jsonValue: {
            weight: Math.floor(Math.random() * 1000) + 100,
            dimensions: `${Math.floor(Math.random() * 100)}x${Math.floor(Math.random() * 100)}x${Math.floor(Math.random() * 100)}`,
            material: 'Steel',
          },
          scope: AttributeScope.SHARED,
        },
      ];

      assetAttributes.forEach((attr) => {
        attributes.push({
          entityType: 'Asset',
          entityId: asset.id,
          attributeKey: attr.attributeKey,
          scope: attr.scope,
          dataType: attr.dataType,
          stringValue: attr.stringValue,
          numberValue: attr.numberValue,
          booleanValue: attr.booleanValue,
          jsonValue: attr.jsonValue,
          lastUpdateTs: getRandomTimestamp(30),
          userId: user?.id || users[0]?.id,
          tenantId: tenant?.id || asset.tenantId,
        });
      });
    }

    // User Attributes (preferences, settings)
    for (const user of users) {
      const tenant = getRandomItem(tenants);

      const userAttributes: Array<{
        attributeKey: string;
        dataType: DataType;
        scope: AttributeScope;
        stringValue?: string;
        numberValue?: number;
        booleanValue?: boolean;
        jsonValue?: any;
      }> = [
        {
          attributeKey: 'theme',
          dataType: DataType.STRING,
          stringValue: ['light', 'dark', 'auto'][Math.floor(Math.random() * 3)],
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'language',
          dataType: DataType.STRING,
          stringValue: ['en', 'ar', 'fr'][Math.floor(Math.random() * 3)],
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'notificationsEnabled',
          dataType: DataType.BOOLEAN,
          booleanValue: Math.random() > 0.3,
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'dashboardLayout',
          dataType: DataType.JSON,
          jsonValue: {
            widgets: ['chart', 'table', 'map'],
            columns: 3,
            autoRefresh: true,
          },
          scope: AttributeScope.CLIENT,
        },
        {
          attributeKey: 'loginHistory',
          dataType: DataType.JSON,
          jsonValue: {
            lastLogin: new Date(getRandomTimestamp(7)).toISOString(),
            loginCount: Math.floor(Math.random() * 100),
            lastIp: `192.168.1.${Math.floor(Math.random() * 255)}`,
          },
          scope: AttributeScope.SERVER,
        },
      ];

      userAttributes.forEach((attr) => {
        attributes.push({
          entityType: 'User',
          entityId: user.id,
          attributeKey: attr.attributeKey,
          scope: attr.scope,
          dataType: attr.dataType,
          stringValue: attr.stringValue,
          numberValue: attr.numberValue,
          booleanValue: attr.booleanValue,
          jsonValue: attr.jsonValue,
          lastUpdateTs: getRandomTimestamp(30),
          userId: user.id,
          tenantId: tenant?.id,
        });
      });
    }

    // Save attributes
    let created = 0;
    let skipped = 0;

    for (const attrData of attributes) {
      const existing = await this.attributeRepository.findOne({
        where: {
          entityType: attrData.entityType,
          entityId: attrData.entityId,
          attributeKey: attrData.attributeKey,
          scope: attrData.scope,
        },
      });

      if (!existing) {
        const attribute = this.attributeRepository.create(attrData);
        await this.attributeRepository.save(attribute);
        created++;
      } else {
        skipped++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Devices: ~${devices.length * 14} attributes`);
    console.log(`   Assets: ~${assets.length * 9} attributes`);
    console.log(`   Users: ~${users.length * 5} attributes`);
    console.log(`   Total: ${created} created, ${skipped} skipped`);
    console.log('🎉 Attribute seeding completed!');
  }
}
