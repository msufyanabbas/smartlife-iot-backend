import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { 
  FloorPlanStatus, 
  DeviceAnimationType 
} from '@modules/floor-plans/entities/floor-plan.entity';
import { FloorPlan, User, Device, Asset } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class FloorPlanSeeder implements ISeeder {
  constructor(
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all users, devices, and assets first
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 100 });
    const assets = await this.assetRepository.find({ take: 20 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    if (assets.length === 0) {
      console.log('⚠️  No assets found. Please seed assets first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper function to get multiple random items
    const getRandomItems = <T>(array: T[], count: number): T[] => {
      const shuffled = [...array].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, Math.min(count, array.length));
    };

    // Helper function to generate random 3D position
    const generateRandom3DPosition = (
      maxX: number,
      maxY: number,
      floorHeight: number = 3.0,
    ) => ({
      x: parseFloat((Math.random() * maxX).toFixed(2)),
      y: parseFloat((Math.random() * maxY).toFixed(2)),
      z: parseFloat((Math.random() * (floorHeight - 0.5) + 0.5).toFixed(2)), // 0.5m to floorHeight
    });

    // Helper function to generate zone boundaries
    const generateZoneBoundaries = (
      centerX: number,
      centerY: number,
      size: number,
    ) => [
      { x: centerX - size, y: centerY - size },
      { x: centerX + size, y: centerY - size },
      { x: centerX + size, y: centerY + size },
      { x: centerX - size, y: centerY + size },
    ];

    // Helper function to determine animation type based on device type
    const getAnimationTypeForDevice = (deviceType: string): DeviceAnimationType => {
      const type = deviceType.toLowerCase();
      
      if (type.includes('smoke') || type.includes('fire')) {
        return DeviceAnimationType.SMOKE;
      } else if (type.includes('door')) {
        return DeviceAnimationType.DOOR_OPEN_CLOSE;
      } else if (type.includes('light') || type.includes('lamp')) {
        return DeviceAnimationType.LIGHT_PULSE;
      } else if (type.includes('water') || type.includes('leak')) {
        return DeviceAnimationType.WATER_LEAK;
      } else if (type.includes('temperature') || type.includes('temp')) {
        return DeviceAnimationType.TEMPERATURE_GRADIENT;
      } else if (type.includes('motion') || type.includes('pir')) {
        return DeviceAnimationType.MOTION_WAVE;
      } else if (type.includes('alarm')) {
        return DeviceAnimationType.ALARM_FLASH;
      }
      
      return DeviceAnimationType.NONE;
    };

    // Helper function to get animation config based on type
    const getAnimationConfig = (animationType: DeviceAnimationType) => {
      switch (animationType) {
        case DeviceAnimationType.SMOKE:
          return {
            intensity: 0.7,
            speed: 1.0,
            color: '#808080',
            particleCount: 100,
            radius: 2.0,
          };
        case DeviceAnimationType.DOOR_OPEN_CLOSE:
          return {
            speed: 1.0,
          };
        case DeviceAnimationType.LIGHT_PULSE:
          return {
            intensity: 0.8,
            speed: 1.5,
            color: '#FFFFFF',
          };
        case DeviceAnimationType.WATER_LEAK:
          return {
            intensity: 0.6,
            speed: 1.2,
            color: '#0077BE',
            particleCount: 50,
          };
        case DeviceAnimationType.TEMPERATURE_GRADIENT:
          return {
            intensity: 0.5,
            speed: 1.0,
            color: '#FF6B00',
          };
        case DeviceAnimationType.MOTION_WAVE:
          return {
            intensity: 0.9,
            speed: 2.0,
            radius: 3.0,
          };
        case DeviceAnimationType.ALARM_FLASH:
          return {
            intensity: 1.0,
            speed: 2.5,
            color: '#FF0000',
          };
        default:
          return {};
      }
    };

    // Helper function to generate telemetry bindings based on device type
    const getTelemetryBindings = (deviceType: string, animationType: DeviceAnimationType) => {
      const type = deviceType.toLowerCase();
      const bindings: any = {};

      if (type.includes('smoke') && animationType === DeviceAnimationType.SMOKE) {
        bindings.smoke_level = {
          animationProperty: 'intensity',
          min: 0,
          max: 100,
        };
      }

      if (type.includes('temperature') && animationType === DeviceAnimationType.TEMPERATURE_GRADIENT) {
        bindings.temperature = {
          animationProperty: 'color',
          min: 20,
          max: 100,
        };
      }

      if (type.includes('door')) {
        bindings.door_state = {
          animationProperty: 'state',
          min: 0,
          max: 1,
        };
      }

      if (type.includes('motion')) {
        bindings.motion_detected = {
          animationProperty: 'intensity',
          min: 0,
          max: 1,
        };
      }

      return Object.keys(bindings).length > 0 ? bindings : undefined;
    };

    // Generate 3D device placements for floor plans
    const generate3DDevicePlacements = (
      deviceCount: number,
      width: number,
      height: number,
      floorHeight: number = 3.0,
    ) => {
      const selectedDevices = getRandomItems(devices, deviceCount);
      return selectedDevices.map((device) => {
        const animationType = getAnimationTypeForDevice(device.type || 'sensor');
        const position = generateRandom3DPosition(width, height, floorHeight);
        
        return {
          deviceId: device.id,
          name: device.name,
          type: device.type || 'sensor',
          position,
          rotation: { x: 0, y: 0, z: parseFloat((Math.random() * 360).toFixed(0)) },
          scale: { x: 1, y: 1, z: 1 },
          model3DUrl: `https://cdn.smartlife.com/models/${device.type || 'default'}.glb`,
          animationType,
          animationConfig: getAnimationConfig(animationType),
          telemetryBindings: getTelemetryBindings(device.type || 'sensor', animationType),
          status: Math.random() > 0.1 ? 'online' : 'offline', // 90% online
        };
      });
    };

    // Sample parsed DWG geometry (placeholder)
    const generateSampleGeometry = (width: number, height: number) => ({
      walls: [
        {
          id: 'wall-1',
          points: [
            { x: 0, y: 0, z: 0 },
            { x: width, y: 0, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
        {
          id: 'wall-2',
          points: [
            { x: width, y: 0, z: 0 },
            { x: width, y: height, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
        {
          id: 'wall-3',
          points: [
            { x: width, y: height, z: 0 },
            { x: 0, y: height, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
        {
          id: 'wall-4',
          points: [
            { x: 0, y: height, z: 0 },
            { x: 0, y: 0, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
      ],
      doors: [
        {
          id: 'door-1',
          position: { x: width / 2, y: 0, z: 0 },
          width: 0.9,
          height: 2.1,
          rotation: 0,
          type: 'single' as const,
        },
      ],
      windows: [
        {
          id: 'window-1',
          position: { x: width * 0.25, y: height, z: 1.2 },
          width: 1.5,
          height: 1.2,
          rotation: 90,
        },
        {
          id: 'window-2',
          position: { x: width * 0.75, y: height, z: 1.2 },
          width: 1.5,
          height: 1.2,
          rotation: 90,
        },
      ],
      rooms: [
        {
          id: 'room-1',
          name: 'Main Area',
          boundaries: [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
          ],
          area: width * height,
          floor: 'ground',
        },
      ],
      stairs: [],
      furniture: [],
    });

    const floorPlans: any = [
      {
        name: 'Headquarters Main Floor',
        building: 'HQ Tower A',
        floor: 'Ground Floor',
        floorNumber: 0,
        assetId: getRandomItem(assets).id,
        imageUrl: 'https://example.com/floorplans/hq-ground.png',
        category: 'Office',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 120,
          height: 80,
          unit: 'meters' as const,
        },
        scale: '1:100',
        parsedGeometry: generateSampleGeometry(120, 80),
        devices: generate3DDevicePlacements(12, 120, 80),
        zones: [
          {
            id: 'zone-1',
            name: 'Reception Area',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(20, 15, 10),
            floor: 'Ground Floor',
            deviceIds: [],
          },
          {
            id: 'zone-2',
            name: 'Open Office Space',
            color: '#10B981',
            boundaries: generateZoneBoundaries(60, 40, 25),
            floor: 'Ground Floor',
            deviceIds: [],
          },
          {
            id: 'zone-3',
            name: 'Meeting Rooms',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(100, 20, 15),
            floor: 'Ground Floor',
            deviceIds: [],
          },
        ],
        building3DMetadata: {
          buildingName: 'HQ Tower A',
          totalFloors: 3,
          floorHeight: 3.5,
          buildingDimensions: {
            width: 120,
            length: 80,
            height: 10.5,
          },
          floorOrder: ['ground', 'first', 'second'],
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
        createdBy: users[0].id,
      },
      {
        name: 'Manufacturing Floor - Assembly Line',
        building: 'Factory 1',
        floor: 'Level 1',
        floorNumber: 0,
        assetId: getRandomItem(assets).id,
        imageUrl: 'https://example.com/floorplans/factory-assembly.png',
        category: 'Industrial',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 200,
          height: 150,
          unit: 'meters' as const,
        },
        scale: '1:200',
        parsedGeometry: generateSampleGeometry(200, 150),
        devices: generate3DDevicePlacements(24, 200, 150, 4.5),
        zones: [
          {
            id: 'zone-1',
            name: 'Assembly Station A',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(40, 40, 20),
            floor: 'Level 1',
            deviceIds: [],
          },
          {
            id: 'zone-2',
            name: 'Assembly Station B',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(100, 40, 20),
            floor: 'Level 1',
            deviceIds: [],
          },
          {
            id: 'zone-3',
            name: 'Quality Control',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(160, 40, 20),
            floor: 'Level 1',
            deviceIds: [],
          },
          {
            id: 'zone-4',
            name: 'Packaging Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(100, 110, 30),
            floor: 'Level 1',
            deviceIds: [],
          },
        ],
        building3DMetadata: {
          buildingName: 'Factory 1',
          totalFloors: 2,
          floorHeight: 4.5,
          buildingDimensions: {
            width: 200,
            length: 150,
            height: 9.0,
          },
          floorOrder: ['ground', 'first'],
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
        createdBy: users[0].id,
      },
      {
        name: 'Warehouse Storage Layout',
        building: 'Logistics Center',
        floor: 'Warehouse A',
        floorNumber: 0,
        assetId: getRandomItem(assets).id,
        imageUrl: 'https://example.com/floorplans/warehouse-a.png',
        category: 'Warehouse',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 180,
          height: 120,
          unit: 'meters' as const,
        },
        scale: '1:150',
        parsedGeometry: generateSampleGeometry(180, 120),
        devices: generate3DDevicePlacements(16, 180, 120, 6.0),
        zones: [
          {
            id: 'zone-1',
            name: 'Receiving Dock',
            color: '#10B981',
            boundaries: generateZoneBoundaries(20, 20, 15),
            floor: 'Warehouse A',
            deviceIds: [],
          },
          {
            id: 'zone-2',
            name: 'Storage Rack Section A',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(60, 60, 25),
            floor: 'Warehouse A',
            deviceIds: [],
          },
          {
            id: 'zone-3',
            name: 'Storage Rack Section B',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(120, 60, 25),
            floor: 'Warehouse A',
            deviceIds: [],
          },
          {
            id: 'zone-4',
            name: 'Shipping Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(90, 100, 20),
            floor: 'Warehouse A',
            deviceIds: [],
          },
        ],
        building3DMetadata: {
          buildingName: 'Logistics Center',
          totalFloors: 1,
          floorHeight: 6.0,
          buildingDimensions: {
            width: 180,
            length: 120,
            height: 6.0,
          },
          floorOrder: ['warehouse'],
        },
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
        createdBy: users[1]?.id || users[0].id,
      },
      {
        name: 'Data Center Floor Plan',
        building: 'Data Center 1',
        floor: 'Server Room',
        floorNumber: 0,
        assetId: getRandomItem(assets).id,
        imageUrl: 'https://example.com/floorplans/datacenter.png',
        category: 'Data Center',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 100,
          height: 80,
          unit: 'meters' as const,
        },
        scale: '1:50',
        parsedGeometry: generateSampleGeometry(100, 80),
        devices: generate3DDevicePlacements(32, 100, 80),
        zones: [
          {
            id: 'zone-1',
            name: 'Server Rack Row 1',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(25, 30, 10),
            floor: 'Server Room',
            deviceIds: [],
          },
          {
            id: 'zone-2',
            name: 'Server Rack Row 2',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(50, 30, 10),
            floor: 'Server Room',
            deviceIds: [],
          },
          {
            id: 'zone-3',
            name: 'Server Rack Row 3',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(75, 30, 10),
            floor: 'Server Room',
            deviceIds: [],
          },
          {
            id: 'zone-4',
            name: 'Cooling Equipment',
            color: '#14B8A6',
            boundaries: generateZoneBoundaries(50, 65, 15),
            floor: 'Server Room',
            deviceIds: [],
          },
        ],
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
        createdBy: users[2]?.id || users[0].id,
      },
      {
        name: 'Smart City Control Center',
        building: 'NEOM Operations',
        floor: 'Level 3',
        floorNumber: 2,
        assetId: getRandomItem(assets).id,
        imageUrl: 'https://example.com/floorplans/smart-city.png',
        category: 'Smart City',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 160,
          height: 100,
          unit: 'meters' as const,
        },
        scale: '1:120',
        parsedGeometry: generateSampleGeometry(160, 100),
        devices: generate3DDevicePlacements(28, 160, 100),
        zones: [
          {
            id: 'zone-1',
            name: 'Main Control Room',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(80, 40, 40),
            floor: 'Level 3',
            deviceIds: [],
          },
          {
            id: 'zone-2',
            name: 'Server Room',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(30, 80, 15),
            floor: 'Level 3',
            deviceIds: [],
          },
          {
            id: 'zone-3',
            name: 'Network Operations',
            color: '#10B981',
            boundaries: generateZoneBoundaries(130, 80, 20),
            floor: 'Level 3',
            deviceIds: [],
          },
        ],
        building3DMetadata: {
          buildingName: 'NEOM Operations',
          totalFloors: 5,
          floorHeight: 3.8,
          buildingDimensions: {
            width: 160,
            length: 100,
            height: 19.0,
          },
          floorOrder: ['ground', 'first', 'second', 'third', 'fourth'],
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        createdBy: getRandomItem(users).id,
      },
      {
        name: 'Office Building - Draft Plan',
        building: 'New Office Tower',
        floor: 'Level 5',
        floorNumber: 4,
        assetId: getRandomItem(assets).id,
        category: 'Office',
        status: FloorPlanStatus.DRAFT,
        dimensions: {
          width: 110,
          height: 70,
          unit: 'meters' as const,
        },
        scale: '1:100',
        devices: [],
        zones: [
          {
            id: 'zone-1',
            name: 'Open Space',
            color: '#9CA3AF',
            boundaries: generateZoneBoundaries(55, 35, 30),
            floor: 'Level 5',
            deviceIds: [],
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        createdBy: getRandomItem(users).id,
      },
      {
        name: 'Processing Floor - Factory 1',
        building: 'Factory 1',
        floor: 'Level 2',
        floorNumber: 1,
        assetId: getRandomItem(assets).id,
        category: 'Industrial',
        status: FloorPlanStatus.PROCESSING,
        dimensions: {
          width: 200,
          height: 150,
          unit: 'meters' as const,
        },
        scale: '1:200',
        dwgFileUrl: '/uploads/floor-plans/dwg/processing-floor.dwg',
        dwgFileSizeBytes: 2547892,
        dwgUploadedAt: new Date(Date.now() - 3600000), // 1 hour ago
        devices: [],
        zones: [],
        userId: users[0].id,
        tenantId: users[0].tenantId,
        createdBy: users[0].id,
      },
    ];

    let createdCount = 0;
    let existingCount = 0;

    for (const floorPlanData of floorPlans) {
      const existing = await this.floorPlanRepository.findOne({
        where: {
          name: floorPlanData.name,
          building: floorPlanData.building,
          userId: floorPlanData.userId,
        },
      });

      if (!existing) {
        const floorPlan = this.floorPlanRepository.create(floorPlanData);
        await this.floorPlanRepository.save(floorPlan);
        createdCount++;
        console.log(
          `✅ Created floor plan: ${floorPlanData.name} - ${floorPlanData.building} (${floorPlanData.status})`,
        );
      } else {
        existingCount++;
        console.log(
          `⏭️  Floor plan already exists: ${floorPlanData.name} - ${floorPlanData.building}`,
        );
      }
    }

    console.log('\n🎉 Floor plan seeding completed!');
    console.log(`   ✅ Created: ${createdCount}`);
    console.log(`   ⏭️  Existing: ${existingCount}`);
    console.log(`   📊 Total: ${floorPlans.length}`);
  }
}