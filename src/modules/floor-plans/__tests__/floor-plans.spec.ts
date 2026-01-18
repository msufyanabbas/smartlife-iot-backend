import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FloorPlansModule } from '../floor-plans.module';
import { FloorPlan, FloorPlanStatus } from '../entities/floor-plan.entity';
import * as fs from 'fs';
import * as path from 'path';

describe('Floor Plans E2E Tests', () => {
  let app: INestApplication;
  let floorPlanRepository: Repository<FloorPlan>;
  let authToken: string;
  let userId: string;
  let assetId: string;
  let createdFloorPlanIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        // Configure TypeORM for testing
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.TEST_DB_HOST || 'localhost',
          port: parseInt(process.env.TEST_DB_PORT || '5432'),
          username: process.env.TEST_DB_USER || 'postgres',
          password: process.env.TEST_DB_PASSWORD || 'postgres',
          database: process.env.TEST_DB_NAME || 'smartlife_test',
          entities: [FloorPlan], // Add all your entities here
          synchronize: true, // Auto-create schema (only for testing!)
          dropSchema: true, // Drop schema before each test run
          logging: false,
        }),
        FloorPlansModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    floorPlanRepository = moduleFixture.get(getRepositoryToken(FloorPlan));

    // Mock authentication - replace with actual auth in your tests
    authToken = 'test-jwt-token';
    userId = 'test-user-uuid';
    assetId = 'test-asset-uuid';
  });

  afterAll(async () => {
    // Cleanup
    if (createdFloorPlanIds.length > 0) {
      await floorPlanRepository.delete(createdFloorPlanIds);
    }
    if (app) {
      await app.close();
    }
  });

  describe('Floor Plan CRUD Operations', () => {
    let floorPlanId: string;

    it('should create a new floor plan', async () => {
      const createDto = {
        name: 'Test Ground Floor',
        building: 'Test Building A',
        floor: 'Ground Floor',
        floorNumber: 0,
        assetId: assetId,
        category: 'Commercial',
        dimensions: {
          width: 50,
          height: 40,
          unit: 'meters',
        },
        scale: '1:100',
      };

      const response = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe(createDto.name);
      expect(response.body.status).toBe('draft');
      expect(response.body.devices).toEqual([]);
      expect(response.body.zones).toEqual([]);

      floorPlanId = response.body.id;
      createdFloorPlanIds.push(floorPlanId);
    });

    it('should get all floor plans', async () => {
      const response = await request(app.getHttpServer())
        .get('/floor-plans?page=1&limit=10')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('page');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should get floor plans by asset', async () => {
      const response = await request(app.getHttpServer())
        .get(`/floor-plans/asset/${assetId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('should get a single floor plan', async () => {
      const response = await request(app.getHttpServer())
        .get(`/floor-plans/${floorPlanId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.id).toBe(floorPlanId);
    });

    it('should update a floor plan', async () => {
      const updateDto = {
        name: 'Updated Floor Plan Name',
        status: 'active',
      };

      const response = await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateDto)
        .expect(200);

      expect(response.body.name).toBe(updateDto.name);
      expect(response.body.status).toBe(updateDto.status);
    });

    it('should get floor plan statistics', async () => {
      const response = await request(app.getHttpServer())
        .get('/floor-plans/statistics')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('active');
      expect(response.body).toHaveProperty('draft');
      expect(response.body).toHaveProperty('totalDevices');
      expect(response.body).toHaveProperty('totalZones');
    });
  });

  describe('DWG File Upload and Processing', () => {
    let floorPlanId: string;

    beforeAll(async () => {
      // Create a test floor plan
      const createDto = {
        name: 'DWG Test Floor',
        building: 'Test Building',
        floor: 'First Floor',
        floorNumber: 1,
        assetId: assetId,
        category: 'Industrial',
        dimensions: { width: 100, height: 80, unit: 'meters' },
      };

      const response = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto);

      floorPlanId = response.body.id;
      createdFloorPlanIds.push(floorPlanId);
    });

    it('should upload a DWG file', async () => {
      // Create a mock DWG file for testing
      const testFilesDir = path.join(__dirname, 'test-files');
      const mockDWGPath = path.join(testFilesDir, 'test-floor.dwg');
      
      // If mock file doesn't exist, create a dummy one
      if (!fs.existsSync(testFilesDir)) {
        fs.mkdirSync(testFilesDir, { recursive: true });
      }
      
      if (!fs.existsSync(mockDWGPath)) {
        fs.writeFileSync(mockDWGPath, Buffer.from('Mock DWG content'));
      }

      const response = await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/dwg-upload`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockDWGPath)
        .expect(200);

      expect(response.body).toHaveProperty('dwgFileUrl');
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('processing');
    });

    it('should fail with invalid file type', async () => {
      const testFilesDir = path.join(__dirname, 'test-files');
      const mockTxtPath = path.join(testFilesDir, 'test.txt');
      
      if (!fs.existsSync(testFilesDir)) {
        fs.mkdirSync(testFilesDir, { recursive: true });
      }
      
      fs.writeFileSync(mockTxtPath, 'Not a DWG file');

      await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/dwg-upload`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockTxtPath)
        .expect(400);

      // Cleanup
      if (fs.existsSync(mockTxtPath)) {
        fs.unlinkSync(mockTxtPath);
      }
    });

    it('should get parsed geometry after processing', async () => {
      // Wait for processing (in real scenario, you'd poll or use webhooks)
      await new Promise(resolve => setTimeout(resolve, 3000));

      const response = await request(app.getHttpServer())
        .get(`/floor-plans/${floorPlanId}/geometry`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('geometry');
      expect(response.body.geometry).toHaveProperty('walls');
      expect(response.body.geometry).toHaveProperty('doors');
      expect(response.body.geometry).toHaveProperty('rooms');
    });
  });

  describe('Device Management', () => {
    let floorPlanId: string;
    let deviceId: string;

    beforeAll(async () => {
      const createDto = {
        name: 'Device Test Floor',
        building: 'Test Building',
        floor: 'Ground Floor',
        assetId: assetId,
        category: 'Commercial',
        dimensions: { width: 50, height: 40, unit: 'meters' },
      };

      const response = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto);

      floorPlanId = response.body.id;
      createdFloorPlanIds.push(floorPlanId);
    });

    it('should add a device to floor plan', async () => {
      const deviceDto = {
        deviceId: 'test-device-uuid-1',
        name: 'Smoke Detector 001',
        type: 'smoke_detector',
        position: { x: 15.5, y: 20.3, z: 2.8 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        animationType: 'smoke',
        animationConfig: {
          intensity: 0.7,
          speed: 1.0,
          color: '#808080',
          particleCount: 100,
        },
        telemetryBindings: {
          smoke_level: {
            animationProperty: 'intensity',
            min: 0,
            max: 100,
          },
        },
      };

      const response = await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/devices`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(deviceDto)
        .expect(201);

      expect(response.body.devices).toHaveLength(1);
      expect(response.body.devices[0].deviceId).toBe(deviceDto.deviceId);
      expect(response.body.devices[0].animationType).toBe('smoke');

      deviceId = deviceDto.deviceId;
    });

    it('should prevent adding duplicate device', async () => {
      const deviceDto = {
        deviceId: deviceId,
        name: 'Duplicate Device',
        type: 'sensor',
        position: { x: 10, y: 10, z: 2 },
        animationType: 'none',
      };

      await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/devices`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(deviceDto)
        .expect(400);
    });

    it('should update device position', async () => {
      const newPosition = { x: 20.0, y: 25.0, z: 3.0 };

      const response = await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanId}/devices/${deviceId}/position`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ position: newPosition })
        .expect(200);

      const device = response.body.devices.find((d: any) => d.deviceId === deviceId);
      expect(device.position).toEqual(newPosition);
    });

    it('should update device animation', async () => {
      const animationUpdate = {
        animationType: 'alarm_flash',
        animationConfig: {
          intensity: 1.0,
          speed: 2.0,
          color: '#FF0000',
        },
      };

      const response = await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanId}/devices/${deviceId}/animation`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(animationUpdate)
        .expect(200);

      const device = response.body.devices.find((d: any) => d.deviceId === deviceId);
      expect(device.animationType).toBe('alarm_flash');
      expect(device.animationConfig.color).toBe('#FF0000');
    });

    it('should remove a device', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/floor-plans/${floorPlanId}/devices/${deviceId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.devices).toHaveLength(0);
    });
  });

  describe('Zone Management', () => {
    let floorPlanId: string;
    let zoneId: string;

    beforeAll(async () => {
      const createDto = {
        name: 'Zone Test Floor',
        building: 'Test Building',
        floor: 'Ground Floor',
        assetId: assetId,
        category: 'Commercial',
        dimensions: { width: 50, height: 40, unit: 'meters' },
      };

      const response = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto);

      floorPlanId = response.body.id;
      createdFloorPlanIds.push(floorPlanId);
    });

    it('should add a zone', async () => {
      const zoneDto = {
        name: 'Production Area A',
        color: '#3b82f6',
        boundaries: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 15 },
          { x: 0, y: 15 },
        ],
      };

      const response = await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/zones`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(zoneDto)
        .expect(201);

      expect(response.body.zones).toHaveLength(1);
      expect(response.body.zones[0].name).toBe(zoneDto.name);
      expect(response.body.zones[0]).toHaveProperty('id');

      zoneId = response.body.zones[0].id;
    });

    it('should update a zone', async () => {
      const updateDto = {
        name: 'Production Area A - Updated',
        color: '#22c55e',
      };

      const response = await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanId}/zones/${zoneId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateDto)
        .expect(200);

      const zone = response.body.zones.find((z: any) => z.id === zoneId);
      expect(zone.name).toBe(updateDto.name);
      expect(zone.color).toBe(updateDto.color);
    });

    it('should remove a zone', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/floor-plans/${floorPlanId}/zones/${zoneId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.zones).toHaveLength(0);
    });
  });

  describe('3D Simulation Data', () => {
    const multiFloorAssetId = 'multi-floor-asset-uuid';
    let floorPlanIds: string[] = [];

    beforeAll(async () => {
      // Create multiple floors for the same building
      for (let i = 0; i < 3; i++) {
        const createDto = {
          name: `Floor ${i}`,
          building: 'Multi-Floor Building',
          floor: i === 0 ? 'Ground' : `Floor ${i}`,
          floorNumber: i,
          assetId: multiFloorAssetId,
          category: 'Commercial',
          dimensions: { width: 50, height: 40, unit: 'meters' },
        };

        const response = await request(app.getHttpServer())
          .post('/floor-plans')
          .set('Authorization', `Bearer ${authToken}`)
          .send(createDto);

        floorPlanIds.push(response.body.id);
        createdFloorPlanIds.push(response.body.id);

        // Add a device to each floor
        await request(app.getHttpServer())
          .post(`/floor-plans/${response.body.id}/devices`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            deviceId: `device-floor-${i}`,
            name: `Device Floor ${i}`,
            type: 'sensor',
            position: { x: 10, y: 10, z: 2.5 },
            animationType: 'light_pulse',
          });
      }

      // Set building metadata on first floor
      await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanIds[0]}/building-3d-metadata`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          buildingName: 'Multi-Floor Building',
          totalFloors: 3,
          floorHeight: 3.5,
          buildingDimensions: {
            width: 50,
            length: 40,
            height: 10.5,
          },
          floorOrder: ['ground', 'first', 'second'],
        });
    });

    it('should get complete 3D simulation data', async () => {
      const response = await request(app.getHttpServer())
        .get(`/floor-plans/asset/${multiFloorAssetId}/3d-simulation`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('assetId');
      expect(response.body).toHaveProperty('building');
      expect(response.body).toHaveProperty('floors');
      
      expect(response.body.building.buildingName).toBe('Multi-Floor Building');
      expect(response.body.building.totalFloors).toBe(3);
      expect(response.body.floors).toHaveLength(3);
      expect(response.body.totalDevices).toBe(3);

      // Verify floor order
      expect(response.body.floors[0].floorNumber).toBe(0);
      expect(response.body.floors[1].floorNumber).toBe(1);
      expect(response.body.floors[2].floorNumber).toBe(2);

      // Verify devices are present
      response.body.floors.forEach((floor: any, index: number) => {
        expect(floor.devices).toHaveLength(1);
        expect(floor.devices[0].deviceId).toBe(`device-floor-${index}`);
      });
    });
  });

  describe('Settings Management', () => {
    let floorPlanId: string;

    beforeAll(async () => {
      const createDto = {
        name: 'Settings Test Floor',
        building: 'Test Building',
        floor: 'Ground Floor',
        assetId: assetId,
        category: 'Commercial',
        dimensions: { width: 50, height: 40, unit: 'meters' },
      };

      const response = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto);

      floorPlanId = response.body.id;
      createdFloorPlanIds.push(floorPlanId);
    });

    it('should get default settings', async () => {
      const response = await request(app.getHttpServer())
        .get(`/floor-plans/${floorPlanId}/settings`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('measurementUnit');
      expect(response.body).toHaveProperty('gridSettings');
      expect(response.body).toHaveProperty('defaultColors');
      expect(response.body.measurementUnit).toBe('metric');
    });

    it('should update settings', async () => {
      const settingsUpdate = {
        measurementUnit: 'imperial',
        gridSettings: {
          showGrid: false,
          snapToGrid: false,
          gridSize: 2,
        },
      };

      const response = await request(app.getHttpServer())
        .patch(`/floor-plans/${floorPlanId}/settings`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(settingsUpdate)
        .expect(200);

      expect(response.body.settings.measurementUnit).toBe('imperial');
      expect(response.body.settings.gridSettings.showGrid).toBe(false);
    });

    it('should reset settings to default', async () => {
      const response = await request(app.getHttpServer())
        .post(`/floor-plans/${floorPlanId}/settings/reset`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.settings.measurementUnit).toBe('metric');
      expect(response.body.settings.gridSettings.showGrid).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent floor plan', async () => {
      await request(app.getHttpServer())
        .get('/floor-plans/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });

    it('should return 404 when adding device to non-existent floor plan', async () => {
      await request(app.getHttpServer())
        .post('/floor-plans/00000000-0000-0000-0000-000000000000/devices')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          deviceId: 'test-device',
          name: 'Test',
          type: 'sensor',
          position: { x: 0, y: 0, z: 0 },
          animationType: 'none',
        })
        .expect(404);
    });

    it('should return 404 when removing non-existent device', async () => {
      // First create a floor plan
      const createDto = {
        name: 'Error Test Floor',
        building: 'Test Building',
        floor: 'Ground Floor',
        assetId: assetId,
        category: 'Commercial',
        dimensions: { width: 50, height: 40, unit: 'meters' },
      };

      const createResponse = await request(app.getHttpServer())
        .post('/floor-plans')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto);

      const floorPlanId = createResponse.body.id;
      createdFloorPlanIds.push(floorPlanId);

      // Try to remove non-existent device
      await request(app.getHttpServer())
        .delete(`/floor-plans/${floorPlanId}/devices/non-existent-device`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });
});