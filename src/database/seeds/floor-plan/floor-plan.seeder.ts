import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FloorPlanStatus } from '@modules/floor-plans/entities/floor-plan.entity';
import { FloorPlan, User, Device } from '@modules/index.entities';
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
  ) {}

  async seed(): Promise<void> {
    // Fetch all users and devices first
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 50 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
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

    // Helper function to generate random position
    const generateRandomPosition = (maxX: number, maxY: number) => ({
      x: Math.floor(Math.random() * maxX),
      y: Math.floor(Math.random() * maxY),
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

    // Generate device placements for floor plans
    const generateDevicePlacements = (
      deviceCount: number,
      width: number,
      height: number,
    ) => {
      const selectedDevices = getRandomItems(devices, deviceCount);
      return selectedDevices.map((device) => ({
        deviceId: device.id,
        name: device.name,
        type: device.type || 'sensor',
        position: generateRandomPosition(width, height),
      }));
    };

    const floorPlans = [
      {
        name: 'Headquarters Main Floor',
        building: 'HQ Tower A',
        floor: 'Ground Floor',
        imageUrl: 'https://example.com/floorplans/hq-ground.png',
        category: 'Office',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1200,
          height: 800,
        },
        scale: '1:100',
        devices: generateDevicePlacements(12, 1200, 800),
        zones: [
          {
            id: 'zone-1',
            name: 'Reception Area',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(200, 150, 100),
          },
          {
            id: 'zone-2',
            name: 'Open Office Space',
            color: '#10B981',
            boundaries: generateZoneBoundaries(600, 400, 250),
          },
          {
            id: 'zone-3',
            name: 'Meeting Rooms',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(1000, 200, 150),
          },
        ],
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Manufacturing Floor - Assembly Line',
        building: 'Factory 1',
        floor: 'Level 1',
        imageUrl: 'https://example.com/floorplans/factory-assembly.png',
        category: 'Industrial',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 2000,
          height: 1500,
        },
        scale: '1:200',
        devices: generateDevicePlacements(24, 2000, 1500),
        zones: [
          {
            id: 'zone-1',
            name: 'Assembly Station A',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(400, 400, 200),
          },
          {
            id: 'zone-2',
            name: 'Assembly Station B',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(1000, 400, 200),
          },
          {
            id: 'zone-3',
            name: 'Quality Control',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(1600, 400, 200),
          },
          {
            id: 'zone-4',
            name: 'Packaging Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(1000, 1100, 300),
          },
        ],
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Warehouse Storage Layout',
        building: 'Logistics Center',
        floor: 'Warehouse A',
        imageUrl: 'https://example.com/floorplans/warehouse-a.png',
        category: 'Warehouse',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1800,
          height: 1200,
        },
        scale: '1:150',
        devices: generateDevicePlacements(16, 1800, 1200),
        zones: [
          {
            id: 'zone-1',
            name: 'Receiving Dock',
            color: '#10B981',
            boundaries: generateZoneBoundaries(200, 200, 150),
          },
          {
            id: 'zone-2',
            name: 'Storage Rack Section A',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(600, 600, 250),
          },
          {
            id: 'zone-3',
            name: 'Storage Rack Section B',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(1200, 600, 250),
          },
          {
            id: 'zone-4',
            name: 'Shipping Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(900, 1000, 200),
          },
        ],
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Data Center Floor Plan',
        building: 'Data Center 1',
        floor: 'Server Room',
        imageUrl: 'https://example.com/floorplans/datacenter.png',
        category: 'Data Center',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1000,
          height: 800,
        },
        scale: '1:50',
        devices: generateDevicePlacements(32, 1000, 800),
        zones: [
          {
            id: 'zone-1',
            name: 'Server Rack Row 1',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(250, 300, 100),
          },
          {
            id: 'zone-2',
            name: 'Server Rack Row 2',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(500, 300, 100),
          },
          {
            id: 'zone-3',
            name: 'Server Rack Row 3',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(750, 300, 100),
          },
          {
            id: 'zone-4',
            name: 'Cooling Equipment',
            color: '#14B8A6',
            boundaries: generateZoneBoundaries(500, 650, 150),
          },
        ],
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Hospital Emergency Department',
        building: 'Medical City Hospital',
        floor: 'Ground Floor - ED',
        imageUrl: 'https://example.com/floorplans/hospital-ed.png',
        category: 'Healthcare',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1500,
          height: 1000,
        },
        scale: '1:100',
        devices: generateDevicePlacements(20, 1500, 1000),
        zones: [
          {
            id: 'zone-1',
            name: 'Triage Area',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(300, 200, 150),
          },
          {
            id: 'zone-2',
            name: 'Treatment Rooms',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(750, 400, 300),
          },
          {
            id: 'zone-3',
            name: 'Waiting Area',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(300, 700, 200),
          },
          {
            id: 'zone-4',
            name: 'Trauma Bay',
            color: '#DC2626',
            boundaries: generateZoneBoundaries(1200, 300, 150),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Smart City Control Center',
        building: 'NEOM Operations',
        floor: 'Level 3',
        imageUrl: 'https://example.com/floorplans/smart-city.png',
        category: 'Smart City',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1600,
          height: 1000,
        },
        scale: '1:120',
        devices: generateDevicePlacements(28, 1600, 1000),
        zones: [
          {
            id: 'zone-1',
            name: 'Main Control Room',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(800, 400, 400),
          },
          {
            id: 'zone-2',
            name: 'Server Room',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(300, 800, 150),
          },
          {
            id: 'zone-3',
            name: 'Network Operations',
            color: '#10B981',
            boundaries: generateZoneBoundaries(1300, 800, 200),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Retail Store Main Floor',
        building: 'Riyadh Mall - Tech Store',
        floor: 'Ground Floor',
        imageUrl: 'https://example.com/floorplans/retail-store.png',
        category: 'Retail',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 900,
          height: 600,
        },
        scale: '1:75',
        devices: generateDevicePlacements(14, 900, 600),
        zones: [
          {
            id: 'zone-1',
            name: 'Display Area - Electronics',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(300, 300, 200),
          },
          {
            id: 'zone-2',
            name: 'Checkout Counter',
            color: '#10B981',
            boundaries: generateZoneBoundaries(700, 150, 100),
          },
          {
            id: 'zone-3',
            name: 'Display Area - Accessories',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(700, 450, 150),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Research Laboratory Layout',
        building: 'KAUST Research Center',
        floor: 'Lab Building 3 - Level 2',
        imageUrl: 'https://example.com/floorplans/research-lab.png',
        category: 'Research',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1400,
          height: 900,
        },
        scale: '1:100',
        devices: generateDevicePlacements(18, 1400, 900),
        zones: [
          {
            id: 'zone-1',
            name: 'Chemistry Lab',
            color: '#EC4899',
            boundaries: generateZoneBoundaries(400, 300, 200),
          },
          {
            id: 'zone-2',
            name: 'Biology Lab',
            color: '#10B981',
            boundaries: generateZoneBoundaries(1000, 300, 200),
          },
          {
            id: 'zone-3',
            name: 'Equipment Storage',
            color: '#6B7280',
            boundaries: generateZoneBoundaries(400, 700, 150),
          },
          {
            id: 'zone-4',
            name: 'Analysis Room',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(1000, 700, 150),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Airport Terminal Monitoring',
        building: 'King Khalid International Airport',
        floor: 'Terminal 5 - Departures',
        imageUrl: 'https://example.com/floorplans/airport-terminal.png',
        category: 'Transportation',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 2500,
          height: 1500,
        },
        scale: '1:250',
        devices: generateDevicePlacements(36, 2500, 1500),
        zones: [
          {
            id: 'zone-1',
            name: 'Check-in Area',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(500, 400, 300),
          },
          {
            id: 'zone-2',
            name: 'Security Checkpoint',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(1250, 400, 200),
          },
          {
            id: 'zone-3',
            name: 'Departure Gates',
            color: '#10B981',
            boundaries: generateZoneBoundaries(1800, 800, 400),
          },
          {
            id: 'zone-4',
            name: 'Retail & Dining',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(800, 1100, 300),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'University Campus Building',
        building: 'King Saud University',
        floor: 'Engineering Building - Level 2',
        imageUrl: 'https://example.com/floorplans/university.png',
        category: 'Education',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1300,
          height: 800,
        },
        scale: '1:100',
        devices: generateDevicePlacements(22, 1300, 800),
        zones: [
          {
            id: 'zone-1',
            name: 'Lecture Hall A',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(300, 300, 150),
          },
          {
            id: 'zone-2',
            name: 'Lecture Hall B',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(700, 300, 150),
          },
          {
            id: 'zone-3',
            name: 'Computer Lab',
            color: '#8B5CF6',
            boundaries: generateZoneBoundaries(1050, 300, 150),
          },
          {
            id: 'zone-4',
            name: 'Study Area',
            color: '#10B981',
            boundaries: generateZoneBoundaries(650, 650, 250),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Energy Plant Layout',
        building: 'Yanbu Power Station',
        floor: 'Control Room Level',
        imageUrl: 'https://example.com/floorplans/power-plant.png',
        category: 'Energy',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1800,
          height: 1200,
        },
        scale: '1:200',
        devices: generateDevicePlacements(40, 1800, 1200),
        zones: [
          {
            id: 'zone-1',
            name: 'Main Control Room',
            color: '#DC2626',
            boundaries: generateZoneBoundaries(600, 400, 250),
          },
          {
            id: 'zone-2',
            name: 'Turbine Monitoring',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(1200, 400, 200),
          },
          {
            id: 'zone-3',
            name: 'Electrical Distribution',
            color: '#6366F1',
            boundaries: generateZoneBoundaries(600, 900, 250),
          },
          {
            id: 'zone-4',
            name: 'Emergency Systems',
            color: '#EF4444',
            boundaries: generateZoneBoundaries(1200, 900, 200),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Office Building - Draft Plan',
        building: 'New Office Tower',
        floor: 'Level 5',
        category: 'Office',
        status: FloorPlanStatus.DRAFT,
        dimensions: {
          width: 1100,
          height: 700,
        },
        scale: '1:100',
        devices: [],
        zones: [
          {
            id: 'zone-1',
            name: 'Open Space',
            color: '#9CA3AF',
            boundaries: generateZoneBoundaries(550, 350, 300),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Old Warehouse Layout',
        building: 'Legacy Facility',
        floor: 'Warehouse B',
        imageUrl: 'https://example.com/floorplans/old-warehouse.png',
        category: 'Warehouse',
        status: FloorPlanStatus.ARCHIVED,
        dimensions: {
          width: 1500,
          height: 1000,
        },
        scale: '1:150',
        devices: [],
        zones: [],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Hotel Conference Center',
        building: 'Riyadh Grand Hotel',
        floor: 'Conference Level',
        imageUrl: 'https://example.com/floorplans/hotel-conference.png',
        category: 'Hospitality',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 1600,
          height: 900,
        },
        scale: '1:120',
        devices: generateDevicePlacements(16, 1600, 900),
        zones: [
          {
            id: 'zone-1',
            name: 'Main Ballroom',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(800, 450, 400),
          },
          {
            id: 'zone-2',
            name: 'Meeting Room A',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(300, 700, 100),
          },
          {
            id: 'zone-3',
            name: 'Meeting Room B',
            color: '#3B82F6',
            boundaries: generateZoneBoundaries(600, 700, 100),
          },
          {
            id: 'zone-4',
            name: 'Pre-function Area',
            color: '#10B981',
            boundaries: generateZoneBoundaries(1300, 450, 250),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Construction Site Office',
        building: 'Red Sea Project',
        floor: 'Site Office 12',
        imageUrl: 'https://example.com/floorplans/construction-site.png',
        category: 'Construction',
        status: FloorPlanStatus.ACTIVE,
        dimensions: {
          width: 800,
          height: 600,
        },
        scale: '1:50',
        devices: generateDevicePlacements(8, 800, 600),
        zones: [
          {
            id: 'zone-1',
            name: 'Project Office',
            color: '#F59E0B',
            boundaries: generateZoneBoundaries(400, 200, 150),
          },
          {
            id: 'zone-2',
            name: 'Equipment Storage',
            color: '#6B7280',
            boundaries: generateZoneBoundaries(400, 450, 150),
          },
        ],
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

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
        console.log(
          `✅ Created floor plan: ${floorPlanData.name} - ${floorPlanData.building} (${floorPlanData.status})`,
        );
      } else {
        console.log(
          `⏭️  Floor plan already exists: ${floorPlanData.name} - ${floorPlanData.building}`,
        );
      }
    }

    console.log('🎉 Floor plan seeding completed!');
  }
}
