import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetType } from '@modules/assets/entities/asset.entity';
import { Asset, AssetProfile, Tenant, User } from '@modules/index.entities';
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch related entities
    const tenants = await this.tenantRepository.find({ take: 5 });
    const users = await this.userRepository.find({ take: 10 });
    const assetProfiles = await this.assetProfileRepository.find();

    if (tenants.length === 0) {
      console.log(
        '⚠️  No tenants found. Creating assets without tenant associations.',
      );
    }

    if (assetProfiles.length === 0) {
      console.log(
        '⚠️  No asset profiles found. Please seed asset profiles first.',
      );
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const getRandomDate = (
      daysOffset: number,
      future: boolean = false,
    ): Date => {
      const date = new Date();
      if (future) {
        date.setDate(date.getDate() + daysOffset);
      } else {
        date.setDate(date.getDate() - daysOffset);
      }
      return date;
    };

    const cities = [
      { name: 'Riyadh', country: 'Saudi Arabia', lat: 24.7136, lng: 46.6753 },
      { name: 'Jeddah', country: 'Saudi Arabia', lat: 21.4858, lng: 39.1925 },
      { name: 'Dammam', country: 'Saudi Arabia', lat: 26.4207, lng: 50.0888 },
      { name: 'Dubai', country: 'UAE', lat: 25.2048, lng: 55.2708 },
      { name: 'Abu Dhabi', country: 'UAE', lat: 24.4539, lng: 54.3773 },
      { name: 'Doha', country: 'Qatar', lat: 25.2854, lng: 51.531 },
    ];

    // Create parent assets (buildings, infrastructure)
    const parentAssets: Partial<Asset>[] = [
      {
        name: 'Headquarters Building',
        label: 'HQ-001',
        type: AssetType.BUILDING,
        tenantId: getRandomItem(tenants)?.id,
        assetProfileId:
          assetProfiles.find((p) => p.name === 'Building Infrastructure')?.id ||
          getRandomItem(assetProfiles)?.id,
        description: 'Main headquarters building with 10 floors',
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
        },
        tags: ['headquarters', 'office', 'commercial'],
        active: true,
        ownerId: getRandomItem(users)?.id,
        ownerName: getRandomItem(users)?.email?.split('@')[0],
        maintenance: {
          lastServiceDate: getRandomDate(30),
          nextServiceDate: getRandomDate(60, true),
          serviceInterval: 90,
        },
        additionalInfo: {
          buildingManager: 'John Smith',
          securityLevel: 'High',
          accessControl: true,
        },
      },
      {
        name: 'Manufacturing Facility',
        label: 'MFG-001',
        type: AssetType.INFRASTRUCTURE,
        tenantId: getRandomItem(tenants)?.id,
        assetProfileId:
          assetProfiles.find((p) => p.name === 'Industrial Equipment')?.id ||
          getRandomItem(assetProfiles)?.id,
        description: 'Primary manufacturing and assembly facility',
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
        },
        tags: ['manufacturing', 'industrial', 'production'],
        active: true,
        ownerId: getRandomItem(users)?.id,
        ownerName: getRandomItem(users)?.email?.split('@')[0],
        maintenance: {
          lastServiceDate: getRandomDate(15),
          nextServiceDate: getRandomDate(45, true),
          serviceInterval: 60,
        },
      },
      {
        name: 'Data Center Alpha',
        label: 'DC-ALPHA',
        type: AssetType.BUILDING,
        tenantId: getRandomItem(tenants)?.id,
        assetProfileId: getRandomItem(assetProfiles)?.id,
        description: 'Primary data center with redundant power and cooling',
        location: {
          address: 'Tech Park',
          city: 'Dubai',
          country: 'UAE',
          zip: '00000',
          latitude: 25.2048,
          longitude: 55.2708,
        },
        attributes: {
          rackCapacity: 500,
          powerCapacity: 5000,
          coolingType: 'Precision Air Conditioning',
          uptime: 99.99,
        },
        tags: ['datacenter', 'technology', 'critical'],
        active: true,
        ownerId: getRandomItem(users)?.id,
        ownerName: getRandomItem(users)?.email?.split('@')[0],
        maintenance: {
          lastServiceDate: getRandomDate(7),
          nextServiceDate: getRandomDate(23, true),
          serviceInterval: 30,
        },
      },
      {
        name: 'Warehouse Complex',
        label: 'WH-001',
        type: AssetType.INFRASTRUCTURE,
        tenantId: getRandomItem(tenants)?.id,
        assetProfileId: getRandomItem(assetProfiles)?.id,
        description: 'Main storage and distribution warehouse',
        location: {
          address: 'Logistics Zone',
          city: 'Jeddah',
          state: 'Makkah Region',
          country: 'Saudi Arabia',
          zip: '23531',
          latitude: 21.4858,
          longitude: 39.1925,
        },
        attributes: {
          storageCapacity: 100000,
          dockDoors: 20,
          temperatureControlled: true,
        },
        tags: ['warehouse', 'logistics', 'storage'],
        active: true,
        ownerId: getRandomItem(users)?.id,
        ownerName: getRandomItem(users)?.email?.split('@')[0],
        maintenance: {
          lastServiceDate: getRandomDate(20),
          nextServiceDate: getRandomDate(70, true),
          serviceInterval: 90,
        },
      },
    ];

    // Save parent assets first
    const savedParents: Asset[] = [];
    for (const parentData of parentAssets) {
      const existing = await this.assetRepository.findOne({
        where: { name: parentData.name },
      });

      if (!existing) {
        const asset = this.assetRepository.create(parentData);
        const saved = await this.assetRepository.save(asset);
        savedParents.push(saved);
        console.log(
          `✅ Created parent asset: ${parentData.name} (${parentData.type})`,
        );
      } else {
        savedParents.push(existing);
        console.log(`⏭️  Parent asset already exists: ${parentData.name}`);
      }
    }

    // Create child assets
    const childAssets: Partial<Asset>[] = [];

    // Floors for HQ Building
    if (savedParents[0]) {
      for (let i = 1; i <= 5; i++) {
        childAssets.push({
          name: `Floor ${i}`,
          label: `HQ-F${String(i).padStart(2, '0')}`,
          type: AssetType.FLOOR,
          tenantId: savedParents[0].tenantId,
          parentAssetId: savedParents[0].id,
          assetProfileId: savedParents[0].assetProfileId,
          description: `Floor ${i} of headquarters building`,
          attributes: {
            floorNumber: i,
            area: 5000,
            departments: i === 1 ? ['Reception', 'Security'] : ['Operations'],
          },
          tags: ['floor', 'office'],
          active: true,
        });
      }
    }

    // Rooms for floors
    if (savedParents[0]) {
      const roomTypes = [
        'Conference Room',
        'Server Room',
        'Office',
        'Meeting Room',
        'Break Room',
      ];
      for (let i = 0; i < 8; i++) {
        const roomType = getRandomItem(roomTypes);
        childAssets.push({
          name: `${roomType} ${i + 1}`,
          label: `HQ-R${String(i + 1).padStart(3, '0')}`,
          type: AssetType.ROOM,
          tenantId: savedParents[0].tenantId,
          parentAssetId: savedParents[0].id,
          assetProfileId: savedParents[0].assetProfileId,
          description: `${roomType} on floor ${Math.ceil((i + 1) / 2)}`,
          attributes: {
            capacity: roomType === 'Conference Room' ? 20 : 8,
            hasAV:
              roomType?.includes('Conference') || roomType?.includes('Meeting'),
          },
          tags: ['room', roomType?.toLowerCase().replace(' ', '-') || ''],
          active: true,
        });
      }
    }

    // Equipment for Manufacturing Facility
    if (savedParents[1]) {
      const equipmentList = [
        { name: 'CNC Machine #1', power: 15 },
        { name: 'CNC Machine #2', power: 15 },
        { name: 'Injection Molding Machine', power: 30 },
        { name: 'Industrial Robot Arm', power: 10 },
        { name: 'Assembly Line Conveyor', power: 5 },
        { name: 'Quality Control Station', power: 2 },
      ];

      equipmentList.forEach((equip, idx) => {
        childAssets.push({
          name: equip.name,
          label: `MFG-EQ-${String(idx + 1).padStart(3, '0')}`,
          type: AssetType.EQUIPMENT,
          tenantId: savedParents[1].tenantId,
          parentAssetId: savedParents[1].id,
          assetProfileId:
            assetProfiles.find((p) => p.name === 'Industrial Equipment')?.id ||
            getRandomItem(assetProfiles)?.id,
          description: `Manufacturing equipment - ${equip.name}`,
          attributes: {
            powerRating: equip.power,
            manufacturer: 'Industrial Corp',
            modelYear: 2020 + idx,
            operatingHours: Math.floor(Math.random() * 10000),
          },
          tags: ['equipment', 'manufacturing', 'machinery'],
          active: true,
          ownerId: getRandomItem(users)?.id,
          ownerName: getRandomItem(users)?.email?.split('@')[0],
          maintenance: {
            lastServiceDate: getRandomDate(Math.floor(Math.random() * 30) + 1),
            nextServiceDate: getRandomDate(
              Math.floor(Math.random() * 60) + 30,
              true,
            ),
            warrantyExpiry: getRandomDate(365, true),
            serviceInterval: 90,
          },
        });
      });
    }

    // Vehicles
    const vehicleList = [
      { name: 'Delivery Van #1', type: 'Van', plate: 'ABC-123' },
      { name: 'Delivery Van #2', type: 'Van', plate: 'ABC-124' },
      { name: 'Company Car #1', type: 'Sedan', plate: 'XYZ-456' },
      { name: 'Service Truck #1', type: 'Truck', plate: 'SRV-789' },
      { name: 'Forklift #1', type: 'Forklift', plate: 'FLT-001' },
    ];

    vehicleList.forEach((vehicle, idx) => {
      const city = getRandomItem(cities);
      childAssets.push({
        name: vehicle.name,
        label: vehicle.plate,
        type: AssetType.VEHICLE,
        tenantId: getRandomItem(tenants)?.id,
        assetProfileId:
          assetProfiles.find((p) => p.name === 'Vehicle Fleet')?.id ||
          getRandomItem(assetProfiles)?.id,
        description: `${vehicle.type} for company operations`,
        location: city
          ? {
              city: city.name,
              country: city.country,
              latitude: city.lat,
              longitude: city.lng,
            }
          : undefined,
        attributes: {
          vehicleType: vehicle.type,
          licensePlate: vehicle.plate,
          fuelType: vehicle.type === 'Forklift' ? 'Electric' : 'Diesel',
          odometer: Math.floor(Math.random() * 100000),
          year: 2019 + idx,
        },
        tags: ['vehicle', 'fleet', vehicle.type.toLowerCase()],
        active: true,
        ownerId: getRandomItem(users)?.id,
        ownerName: getRandomItem(users)?.email?.split('@')[0],
        maintenance: {
          lastServiceDate: getRandomDate(Math.floor(Math.random() * 60) + 1),
          nextServiceDate: getRandomDate(
            Math.floor(Math.random() * 30) + 30,
            true,
          ),
          serviceInterval: 180,
        },
      });
    });

    // IoT Equipment (Sensors, Meters, etc.)
    const iotDevices = [
      { name: 'Temperature Sensor - Lobby', location: 'HQ Building Lobby' },
      { name: 'Humidity Sensor - Server Room', location: 'Data Center' },
      { name: 'Energy Meter - Main Grid', location: 'Electrical Room' },
      { name: 'Air Quality Monitor - Office', location: 'Floor 3' },
      { name: 'Motion Detector - Entrance', location: 'Main Entrance' },
      { name: 'Water Flow Meter', location: 'Utility Room' },
    ];

    iotDevices.forEach((device, idx) => {
      childAssets.push({
        name: device.name,
        label: `IOT-${String(idx + 1).padStart(3, '0')}`,
        type: AssetType.EQUIPMENT,
        tenantId: getRandomItem(tenants)?.id,
        parentAssetId: savedParents[0]?.id,
        assetProfileId:
          assetProfiles.find((p) => p.name === 'IoT Sensors')?.id ||
          getRandomItem(assetProfiles)?.id,
        description: `IoT sensor for monitoring - ${device.name}`,
        attributes: {
          sensorType: device.name.split(' ')[0],
          installationLocation: device.location,
          batteryPowered: true,
          communicationProtocol: 'MQTT',
        },
        tags: ['iot', 'sensor', 'monitoring'],
        active: true,
        maintenance: {
          lastServiceDate: getRandomDate(30),
          nextServiceDate: getRandomDate(335, true),
          serviceInterval: 365,
        },
      });
    });

    // Save all child assets
    let created = 0;
    let skipped = 0;

    for (const childData of childAssets) {
      const existing = await this.assetRepository.findOne({
        where: { name: childData.name, parentAssetId: childData.parentAssetId },
      });

      if (!existing) {
        const asset = this.assetRepository.create(childData);
        await this.assetRepository.save(asset);
        created++;
      } else {
        skipped++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Parents: ${savedParents.length}`);
    console.log(`   Children: ${created} created, ${skipped} skipped`);
    console.log('🎉 Asset seeding completed!');
  }
}
