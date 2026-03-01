// src/database/seeds/floor-plan/floor-plan.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FloorPlanStatus,
  DeviceAnimationType,
} from '@common/enums/index.enum';
import { FloorPlan, User, Tenant, Device, Asset } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class FloorPlanSeeder implements ISeeder {
  private readonly logger = new Logger(FloorPlanSeeder.name);

  constructor(
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting floor plan seeding...');

    // Check if floor plans already exist
    const existingFloorPlans = await this.floorPlanRepository.count();
    if (existingFloorPlans > 0) {
      this.logger.log(
        `⏭️  Floor plans already seeded (${existingFloorPlans} records). Skipping...`,
      );
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });
    const devices = await this.deviceRepository.find({ take: 100 });
    const assets = await this.assetRepository.find({ take: 20 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    if (devices.length === 0) {
      this.logger.warn('⚠️  No devices found. Floor plans will have no device placements.');
    }

    if (assets.length === 0) {
      this.logger.warn('⚠️  No assets found. Floor plans will have no asset associations.');
    }

    this.logger.log(
      `📊 Found ${users.length} users, ${tenants.length} tenants, ${devices.length} devices, ${assets.length} assets`,
    );

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const getRandomItems = <T>(array: T[], count: number): T[] => {
      const shuffled = [...array].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, Math.min(count, array.length));
    };

    const generateRandom3DPosition = (
      maxX: number,
      maxY: number,
      floorHeight: number = 3.0,
    ) => ({
      x: parseFloat((Math.random() * maxX).toFixed(2)),
      y: parseFloat((Math.random() * maxY).toFixed(2)),
      z: parseFloat((Math.random() * (floorHeight - 0.5) + 0.5).toFixed(2)),
    });

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

    const getAnimationTypeForDevice = (
      deviceType: string,
    ): DeviceAnimationType => {
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
          return { speed: 1.0 };
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

    const getTelemetryBindings = (
      deviceType: string,
      animationType: DeviceAnimationType,
    ) => {
      const type = deviceType.toLowerCase();
      const bindings: any = {};

      if (type.includes('smoke') && animationType === DeviceAnimationType.SMOKE) {
        bindings.smoke_level = {
          animationProperty: 'intensity',
          min: 0,
          max: 100,
        };
      }

      if (
        type.includes('temperature') &&
        animationType === DeviceAnimationType.TEMPERATURE_GRADIENT
      ) {
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

    const generate3DDevicePlacements = (
      deviceCount: number,
      width: number,
      height: number,
      floorHeight: number = 3.0,
    ) => {
      if (devices.length === 0) return [];

      const selectedDevices = getRandomItems(devices, deviceCount);
      return selectedDevices.map((device) => {
        const animationType = getAnimationTypeForDevice(device.type || 'sensor');
        const position = generateRandom3DPosition(width, height, floorHeight);

        return {
          deviceId: device.id,
          name: device.name,
          type: device.type || 'sensor',
          position,
          rotation: {
            x: 0,
            y: 0,
            z: parseFloat((Math.random() * 360).toFixed(0)),
          },
          scale: { x: 1, y: 1, z: 1 },
          model3DUrl: `https://cdn.smartlife.com/models/${device.type || 'default'}.glb`,
          animationType,
          animationConfig: getAnimationConfig(animationType),
          telemetryBindings: getTelemetryBindings(
            device.type || 'sensor',
            animationType,
          ),
          status: (Math.random() > 0.9 ? 'offline' :
            Math.random() > 0.85 ? 'alarm' :
              'online') as 'online' | 'offline' | 'alarm',
        };
      });
    };

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

    // ════════════════════════════════════════════════════════════════
    // FLOOR PLAN DATA
    // ════════════════════════════════════════════════════════════════

    const floorPlans: Partial<FloorPlan>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. HEADQUARTERS MAIN FLOOR
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        assetId: assets.length > 0 ? getRandomItem(assets).id : 'asset-placeholder',
        name: 'Headquarters Main Floor',
        building: 'HQ Tower A',
        floor: 'Ground Floor',
        floorNumber: 0,
        category: 'Office',
        description: 'Main floor plan for headquarters building',
        status: FloorPlanStatus.ACTIVE,
        imageUrl: 'https://example.com/floorplans/hq-ground.png',
        thumbnailUrl: 'https://example.com/floorplans/hq-ground-thumb.png',
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
            area: 400,
          },
          {
            id: 'zone-2',
            name: 'Open Office Space',
            color: '#10B981',
            boundaries: generateZoneBoundaries(60, 40, 25),
            floor: 'Ground Floor',
            deviceIds: [],
            area: 2500,
          },
          {
            id: 'zone-3',
            name: 'Meeting Rooms',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(100, 20, 15),
            floor: 'Ground Floor',
            deviceIds: [],
            area: 900,
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
        settings: {
          measurementUnit: 'metric',
          autoSave: true,
          gridSettings: {
            showGrid: true,
            snapToGrid: true,
            gridSize: 1,
          },
          defaultColors: {
            gateways: '#22c55e',
            sensorsToGateway: '#f59e0b',
            zones: '#3b82f6',
            sensorsToGrid: '#a855f7',
          },
        },
        tags: ['3d-enabled', 'office', 'headquarters'],
      },

      // ════════════════════════════════════════════════════════════════
      // 2. MANUFACTURING FLOOR
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        assetId: assets.length > 0 ? getRandomItem(assets).id : 'asset-placeholder',
        name: 'Manufacturing Floor - Assembly Line',
        building: 'Factory 1',
        floor: 'Level 1',
        floorNumber: 0,
        category: 'Industrial',
        description: 'Main manufacturing and assembly floor',
        status: FloorPlanStatus.ACTIVE,
        imageUrl: 'https://example.com/floorplans/factory-assembly.png',
        thumbnailUrl: 'https://example.com/floorplans/factory-assembly-thumb.png',
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
            area: 1600,
          },
          {
            id: 'zone-2',
            name: 'Assembly Station B',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(100, 40, 20),
            floor: 'Level 1',
            deviceIds: [],
            area: 1600,
          },
          {
            id: 'zone-3',
            name: 'Quality Control',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(160, 40, 20),
            floor: 'Level 1',
            deviceIds: [],
            area: 1600,
          },
          {
            id: 'zone-4',
            name: 'Packaging Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(100, 110, 30),
            floor: 'Level 1',
            deviceIds: [],
            area: 3600,
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
        settings: {
          measurementUnit: 'metric',
          autoSave: true,
          gridSettings: {
            showGrid: true,
            snapToGrid: true,
            gridSize: 2,
          },
          defaultColors: {
            gateways: '#22c55e',
            sensorsToGateway: '#f59e0b',
            zones: '#3b82f6',
            sensorsToGrid: '#a855f7',
          },
        },
        tags: ['3d-enabled', 'industrial', 'manufacturing'],
      },

      // ════════════════════════════════════════════════════════════════
      // 3. WAREHOUSE STORAGE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        assetId: assets.length > 0 ? getRandomItem(assets).id : 'asset-placeholder',
        name: 'Warehouse Storage Layout',
        building: 'Logistics Center',
        floor: 'Warehouse A',
        floorNumber: 0,
        category: 'Warehouse',
        description: 'Main warehouse storage and logistics area',
        status: FloorPlanStatus.ACTIVE,
        imageUrl: 'https://example.com/floorplans/warehouse-a.png',
        thumbnailUrl: 'https://example.com/floorplans/warehouse-a-thumb.png',
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
            area: 900,
          },
          {
            id: 'zone-2',
            name: 'Storage Rack Section A',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(60, 60, 25),
            floor: 'Warehouse A',
            deviceIds: [],
            area: 2500,
          },
          {
            id: 'zone-3',
            name: 'Storage Rack Section B',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(120, 60, 25),
            floor: 'Warehouse A',
            deviceIds: [],
            area: 2500,
          },
          {
            id: 'zone-4',
            name: 'Shipping Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(90, 100, 20),
            floor: 'Warehouse A',
            deviceIds: [],
            area: 1600,
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
        settings: {
          measurementUnit: 'metric',
          autoSave: true,
          gridSettings: {
            showGrid: true,
            snapToGrid: true,
            gridSize: 2,
          },
          defaultColors: {
            gateways: '#22c55e',
            sensorsToGateway: '#f59e0b',
            zones: '#3b82f6',
            sensorsToGrid: '#a855f7',
          },
        },
        tags: ['3d-enabled', 'warehouse', 'logistics'],
      },

      // ════════════════════════════════════════════════════════════════
      // 4. DATA CENTER
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        assetId: assets.length > 0 ? getRandomItem(assets).id : 'asset-placeholder',
        name: 'Data Center Floor Plan',
        building: 'Data Center 1',
        floor: 'Server Room',
        floorNumber: 0,
        category: 'Data Center',
        description: 'Primary data center server room layout',
        status: FloorPlanStatus.ACTIVE,
        imageUrl: 'https://example.com/floorplans/datacenter.png',
        thumbnailUrl: 'https://example.com/floorplans/datacenter-thumb.png',
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
            area: 400,
          },
          {
            id: 'zone-2',
            name: 'Server Rack Row 2',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(50, 30, 10),
            floor: 'Server Room',
            deviceIds: [],
            area: 400,
          },
          {
            id: 'zone-3',
            name: 'Server Rack Row 3',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(75, 30, 10),
            floor: 'Server Room',
            deviceIds: [],
            area: 400,
          },
          {
            id: 'zone-4',
            name: 'Cooling Equipment',
            color: '#14B8A6',
            boundaries: generateZoneBoundaries(50, 65, 15),
            floor: 'Server Room',
            deviceIds: [],
            area: 900,
          },
        ],
        settings: {
          measurementUnit: 'metric',
          autoSave: true,
          gridSettings: {
            showGrid: true,
            snapToGrid: true,
            gridSize: 1,
          },
          defaultColors: {
            gateways: '#22c55e',
            sensorsToGateway: '#f59e0b',
            zones: '#3b82f6',
            sensorsToGrid: '#a855f7',
          },
        },
        tags: ['3d-enabled', 'data-center', 'critical-infrastructure'],
      },

      // ════════════════════════════════════════════════════════════════
      // 5. DRAFT FLOOR PLAN
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        assetId: assets.length > 0 ? getRandomItem(assets).id : 'asset-placeholder',
        name: 'Office Building - Draft Plan',
        building: 'New Office Tower',
        floor: 'Level 5',
        floorNumber: 4,
        category: 'Office',
        description: 'Draft floor plan for new office building expansion',
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
            area: 3600,
          },
        ],
        settings: {
          measurementUnit: 'metric',
          autoSave: true,
          gridSettings: {
            showGrid: true,
            snapToGrid: true,
            gridSize: 1,
          },
          defaultColors: {
            gateways: '#22c55e',
            sensorsToGateway: '#f59e0b',
            zones: '#3b82f6',
            sensorsToGrid: '#a855f7',
          },
        },
        tags: ['draft', 'office'],
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL FLOOR PLANS
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const floorPlanData of floorPlans) {
      try {
        const floorPlan = this.floorPlanRepository.create(floorPlanData);
        await this.floorPlanRepository.save(floorPlan);

        const statusTag =
          floorPlan.status === FloorPlanStatus.ACTIVE
            ? '✅ ACTIVE'
            : floorPlan.status === FloorPlanStatus.DRAFT
              ? '📝 DRAFT'
              : floorPlan.status === FloorPlanStatus.PROCESSING
                ? '⏳ PROCESSING'
                : '❌ FAILED';

        const has3D = floorPlan.has3DData() ? '🎨 3D' : '';

        this.logger.log(
          `✅ Created: ${floorPlan.name.substring(0, 35).padEnd(37)} | ` +
          `${floorPlan.building.substring(0, 20).padEnd(22)} | ${statusTag} ${has3D}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed floor plan '${floorPlanData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      byStatus: {} as Record<string, number>,
      byCategory: {} as Record<string, number>,
      with3D: floorPlans.filter(fp => (fp.devices?.length || 0) > 0).length,
      totalDevices: floorPlans.reduce((sum, fp) => sum + (fp.devices?.length || 0), 0),
      totalZones: floorPlans.reduce((sum, fp) => sum + (fp.zones?.length || 0), 0),
    };

    floorPlans.forEach((fp) => {
      if (fp.status) {
        summary.byStatus[fp.status] = (summary.byStatus[fp.status] || 0) + 1;
      }
      if (fp.category) {
        summary.byCategory[fp.category] = (summary.byCategory[fp.category] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Floor plan seeding complete! Created ${createdCount}/${floorPlans.length} floor plans.`,
    );
    this.logger.log('');
    this.logger.log('📊 Floor Plan Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   With 3D Data: ${summary.with3D}`);
    this.logger.log(`   Total Devices: ${summary.totalDevices}`);
    this.logger.log(`   Total Zones: ${summary.totalZones}`);
    this.logger.log('');
    this.logger.log('   By Status:');
    Object.entries(summary.byStatus).forEach(([status, count]) =>
      this.logger.log(`     - ${status.padEnd(20)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Category:');
    Object.entries(summary.byCategory).forEach(([category, count]) =>
      this.logger.log(`     - ${category.padEnd(20)}: ${count}`),
    );
  }
}