// src/database/seeders/attribute.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Attribute, Device, Tenant, User } from '@modules/index.entities';
import { AttributeScope, DataType } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AttributeSeeder implements ISeeder {
  constructor(
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    console.log('🏷️  Seeding attributes...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get first user
    const user = await this.userRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    if (!user) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Get first device
    const device = await this.deviceRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    if (!device) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    const getRandomTimestamp = (daysAgo: number): number => {
      const now = Date.now();
      const offset = daysAgo * 24 * 60 * 60 * 1000;
      return now - Math.floor(Math.random() * offset);
    };

    const attributesData: Partial<Attribute>[] = [
      // 1. Device Server Attribute (Firmware Version)
      {
        tenantId: tenant.id,
        userId: user.id,
        entityType: 'Device',
        entityId: device.id,
        attributeKey: 'firmwareVersion',
        scope: AttributeScope.SERVER,
        dataType: DataType.STRING,
        stringValue: 'v2.1.5',
        lastUpdateTs: getRandomTimestamp(7),
      },

      // 2. Device Shared Attribute (Reporting Interval)
      {
        tenantId: tenant.id,
        userId: user.id,
        entityType: 'Device',
        entityId: device.id,
        attributeKey: 'reportingInterval',
        scope: AttributeScope.SHARED,
        dataType: DataType.NUMBER,
        numberValue: 60,
        lastUpdateTs: getRandomTimestamp(3),
      },

      // 3. Device Client Attribute (Battery Level)
      {
        tenantId: tenant.id,
        userId: user.id,
        entityType: 'Device',
        entityId: device.id,
        attributeKey: 'batteryLevel',
        scope: AttributeScope.CLIENT,
        dataType: DataType.NUMBER,
        numberValue: 85.5,
        lastUpdateTs: getRandomTimestamp(1),
      },

      // 4. Device Shared Attribute (Location)
      {
        tenantId: tenant.id,
        userId: user.id,
        entityType: 'Device',
        entityId: device.id,
        attributeKey: 'location',
        scope: AttributeScope.SHARED,
        dataType: DataType.JSON,
        jsonValue: {
          latitude: 24.7136,
          longitude: 46.6753,
          address: 'King Fahd Road, Riyadh',
        },
        lastUpdateTs: getRandomTimestamp(5),
      },

      // 5. User Client Attribute (Theme Preference)
      {
        tenantId: tenant.id,
        userId: user.id,
        entityType: 'User',
        entityId: user.id,
        attributeKey: 'theme',
        scope: AttributeScope.CLIENT,
        dataType: DataType.STRING,
        stringValue: 'dark',
        lastUpdateTs: getRandomTimestamp(10),
      },
    ];

    for (const attrData of attributesData) {
      const existing = await this.attributeRepository.findOne({
        where: {
          entityType: attrData.entityType,
          entityId: attrData.entityId,
          attributeKey: attrData.attributeKey,
        },
      });

      if (!existing) {
        const attribute = this.attributeRepository.create(attrData);
        await this.attributeRepository.save(attribute);
        console.log(
          `✅ Created attribute: ${attrData.entityType}.${attrData.attributeKey} (${attrData.scope})`,
        );
      } else {
        console.log(
          `⏭️  Attribute already exists: ${attrData.entityType}.${attrData.attributeKey}`,
        );
      }
    }

    console.log('🎉 Attribute seeding completed! (5 attributes created)');
  }
}