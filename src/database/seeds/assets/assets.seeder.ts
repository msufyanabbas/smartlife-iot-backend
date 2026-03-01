// src/database/seeders/asset.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetType } from '@common/enums/asset.enum';
import { Asset, AssetProfile, Tenant, Customer } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AssetSeeder implements ISeeder {
  constructor(
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(AssetProfile)
    private readonly assetProfileRepository: Repository<AssetProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async seed(): Promise<void> {
    console.log('🏢 Seeding assets...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get first customer
    const customer = await this.customerRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    // Get asset profiles
    const assetProfiles = await this.assetProfileRepository.find({
      where: { tenantId: tenant.id },
    });

    if (assetProfiles.length === 0) {
      console.log('⚠️  No asset profiles found. Please seed asset profiles first.');
      return;
    }

    // Helper function
    const getProfileByName = (name: string) => {
      return assetProfiles.find(p => p.name.includes(name)) || assetProfiles[0];
    };

    const assetsData: Partial<Asset>[] = [
      // 1. Smart Building (Root Asset)
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        name: 'Smart City Tower',
        label: 'SCT-001',
        type: AssetType.BUILDING,
        description: 'Main headquarters building with 10 floors',
        assetProfileId: getProfileByName('Building')?.id,
        location: {
          address: 'King Fahd Road',
          city: 'Riyadh',
          state: 'Riyadh Region',
          country: 'Saudi Arabia',
          zip: '11564',
          latitude: 24.7136,
          longitude: 46.6753,
        },
        attributes: {
          floors: 10,
          totalArea: 50000,
          yearBuilt: 2018,
          parkingSpaces: 200,
          buildingCode: 'SCT-001',
        },
        tags: ['headquarters', 'office', 'commercial'],
        active: true,
        childrenCount: 0,
        deviceCount: 0,
        additionalInfo: {
          buildingManager: 'John Smith',
          securityLevel: 'High',
          accessControl: true,
        },
      },

      // 2. Manufacturing Facility
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        name: 'Manufacturing Plant Alpha',
        label: 'MFG-ALPHA',
        type: AssetType.INFRASTRUCTURE,
        description: 'Primary manufacturing and assembly facility',
        assetProfileId: getProfileByName('Industrial')?.id,
        location: {
          address: 'Industrial City',
          city: 'Dammam',
          state: 'Eastern Province',
          country: 'Saudi Arabia',
          zip: '32248',
          latitude: 26.4207,
          longitude: 50.0888,
        },
        attributes: {
          productionCapacity: 10000,
          operatingHours: '24/7',
          certifications: ['ISO9001', 'ISO14001'],
          powerRating: 500,
        },
        tags: ['manufacturing', 'industrial', 'production'],
        active: true,
        childrenCount: 0,
        deviceCount: 0,
      },

      // 3. Vehicle
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        name: 'Delivery Van #1',
        label: 'ABC-123',
        type: AssetType.VEHICLE,
        description: 'Company delivery van',
        assetProfileId: getProfileByName('Vehicle')?.id,
        location: {
          city: 'Riyadh',
          country: 'Saudi Arabia',
          latitude: 24.7136,
          longitude: 46.6753,
        },
        attributes: {
          vehicleType: 'Van',
          licensePlate: 'ABC-123',
          fuelType: 'Diesel',
          odometer: 45000,
          year: 2021,
          make: 'Toyota',
          model: 'Hiace',
        },
        tags: ['vehicle', 'fleet', 'van'],
        active: true,
        childrenCount: 0,
        deviceCount: 0,
      },

      // 4. Equipment
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        name: 'CNC Machine #1',
        label: 'MFG-EQ-001',
        type: AssetType.EQUIPMENT,
        description: 'Computer Numerical Control machining center',
        assetProfileId: getProfileByName('Industrial')?.id,
        location: {
          city: 'Dammam',
          country: 'Saudi Arabia',
        },
        attributes: {
          powerRating: 15,
          manufacturer: 'Haas Automation',
          model: 'VF-2SS',
          modelYear: 2020,
          operatingHours: 8500,
          serialNumber: 'HAAS-VF2-2020-001',
        },
        tags: ['equipment', 'manufacturing', 'machinery', 'cnc'],
        active: true,
        childrenCount: 0,
        deviceCount: 0,
        additionalInfo: {
          purchaseDate: '2020-03-15',
          warrantyExpiry: '2023-03-15',
          maintenanceInterval: 90,
          lastServiceDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },

      // 5. IoT Sensor Equipment
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        name: 'Temperature Sensor - Lobby',
        label: 'IOT-001',
        type: AssetType.EQUIPMENT,
        description: 'IoT temperature sensor for lobby monitoring',
        assetProfileId: getProfileByName('IoT')?.id || getProfileByName('Sensor')?.id,
        location: {
          city: 'Riyadh',
          country: 'Saudi Arabia',
        },
        attributes: {
          sensorType: 'Temperature',
          installationLocation: 'HQ Building Lobby',
          batteryPowered: true,
          communicationProtocol: 'MQTT',
          accuracy: 0.5,
          range: '-20 to 60°C',
        },
        tags: ['iot', 'sensor', 'monitoring', 'temperature'],
        active: true,
        childrenCount: 0,
        deviceCount: 0,
        additionalInfo: {
          installationDate: '2023-06-01',
          calibrationDate: '2024-01-15',
          nextCalibration: '2025-01-15',
        },
      },
    ];

    for (const assetData of assetsData) {
      const existing = await this.assetRepository.findOne({
        where: {
          name: assetData.name,
          tenantId: assetData.tenantId,
        },
      });

      if (!existing) {
        const asset = this.assetRepository.create(assetData);
        await this.assetRepository.save(asset);
        console.log(
          `✅ Created asset: ${assetData.name} (${assetData.type})`,
        );
      } else {
        console.log(
          `⏭️  Asset already exists: ${assetData.name}`,
        );
      }
    }

    console.log('🎉 Asset seeding completed! (5 assets created)');
  }
}