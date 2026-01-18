import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FloorPlan,
  FloorPlanStatus,
  Device3DData,
  DeviceAnimationType,
} from './entities/floor-plan.entity';
import {
  CreateFloorPlanDto,
  AddDeviceToFloorPlanDto,
  AddZoneDto,
  Building3DMetadataDto,
} from './dto/create-floor-plan.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { DWGParserService } from './dwg-parser.service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class FloorPlansService {
  private readonly logger = new Logger(FloorPlansService.name);
  private readonly uploadDir = process.env.UPLOAD_PATH || './uploads/floor-plans';
  private readonly dwgDir = path.join(this.uploadDir, 'dwg');

  constructor(
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    private readonly dwgParserService: DWGParserService,
  ) {
    this.ensureUploadDirectories();
  }

  private async ensureUploadDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true });
      await fs.mkdir(this.dwgDir, { recursive: true });
      this.logger.log('Upload directories initialized');
    } catch (error) {
      this.logger.error('Failed to create upload directories', error);
    }
  }

  async create(
    userId: string,
    createFloorPlanDto: CreateFloorPlanDto,
  ): Promise<FloorPlan> {
    const floorPlan = this.floorPlanRepository.create({
      ...createFloorPlanDto,
      userId,
      createdBy: userId,
      devices: [],
      zones: [],
    });

    return await this.floorPlanRepository.save(floorPlan);
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.floorPlanRepository
      .createQueryBuilder('floorPlan')
      .where('floorPlan.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(floorPlan.name ILIKE :search OR floorPlan.building ILIKE :search OR floorPlan.floor ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`floorPlan.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, userId: string): Promise<FloorPlan> {
    const floorPlan = await this.floorPlanRepository.findOne({
      where: { id, userId },
    });

    if (!floorPlan) {
      throw new NotFoundException('Floor plan not found');
    }

    return floorPlan;
  }

  async findByAsset(assetId: string, userId: string): Promise<FloorPlan[]> {
    return await this.floorPlanRepository.find({
      where: { assetId, userId },
      order: { floorNumber: 'ASC' },
    });
  }

  async update(
    id: string,
    userId: string,
    updateFloorPlanDto: UpdateFloorPlanDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    Object.assign(floorPlan, updateFloorPlanDto);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async remove(id: string, userId: string): Promise<void> {
    const floorPlan = await this.findOne(id, userId);
    
    // Clean up associated files
    if (floorPlan.dwgFileUrl) {
      await this.deleteFile(floorPlan.dwgFileUrl);
    }
    if (floorPlan.thumbnailUrl) {
      await this.deleteFile(floorPlan.thumbnailUrl);
    }

    await this.floorPlanRepository.softRemove(floorPlan);
  }

  /**
   * DWG FILE UPLOAD AND PROCESSING
   */

  async uploadDWGFile(
    id: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    // Validate file type
    if (!file.originalname.toLowerCase().endsWith('.dwg')) {
      throw new BadRequestException('Only DWG files are supported');
    }

    try {
      // Save file
      const fileName = `${uuidv4()}_${file.originalname}`;
      const filePath = path.join(this.dwgDir, fileName);
      await fs.writeFile(filePath, file.buffer);

      // Update floor plan with file info
      floorPlan.dwgFileUrl = `/uploads/floor-plans/dwg/${fileName}`;
      floorPlan.dwgFileSizeBytes = file.size;
      floorPlan.dwgUploadedAt = new Date();
      floorPlan.status = FloorPlanStatus.PROCESSING;
      floorPlan.updatedBy = userId;

      await this.floorPlanRepository.save(floorPlan);

      // Parse DWG file asynchronously
      this.parseDWGFileAsync(id, userId, filePath);

      return floorPlan;
    } catch (error) {
      this.logger.error(`Failed to upload DWG file: ${error.message}`, error.stack);
      throw new BadRequestException('Failed to upload DWG file');
    }
  }

  /**
   * Async DWG parsing (runs in background)
   */
  private async parseDWGFileAsync(
    floorPlanId: string,
    userId: string,
    filePath: string,
  ): Promise<void> {
    try {
      this.logger.log(`Starting async DWG parsing for floor plan: ${floorPlanId}`);

      // Parse DWG file
      const geometry = await this.dwgParserService.parseDWGFile(filePath);

      // Validate geometry
      const validation = this.dwgParserService.validateGeometry(geometry);
      if (!validation.valid) {
        throw new Error(`Invalid DWG geometry: ${validation.errors.join(', ')}`);
      }

      // Generate thumbnail
      const thumbnailPath = filePath.replace('.dwg', '_thumb.png');
      await this.dwgParserService.generateThumbnail(geometry, thumbnailPath);

      // Update floor plan with parsed data
      const floorPlan = await this.findOne(floorPlanId, userId);
      floorPlan.parsedGeometry = geometry;
      floorPlan.status = FloorPlanStatus.ACTIVE;
      floorPlan.parsingError = "";
      
      // Update dimensions from parsed geometry
      if (geometry.rooms && geometry.rooms.length > 0) {
        const bounds = this.calculateBounds(geometry);
        floorPlan.dimensions = {
          width: bounds.width,
          height: bounds.height,
          unit: floorPlan.dimensions.unit || 'meters',
        };
      }

      await this.floorPlanRepository.save(floorPlan);

      this.logger.log(`DWG parsing completed for floor plan: ${floorPlanId}`);
    } catch (error) {
      this.logger.error(
        `DWG parsing failed for floor plan ${floorPlanId}: ${error.message}`,
        error.stack,
      );

      // Update floor plan with error
      const floorPlan = await this.floorPlanRepository.findOne({
        where: { id: floorPlanId },
      });
      
      if (floorPlan) {
        floorPlan.status = FloorPlanStatus.FAILED;
        floorPlan.parsingError = error.message;
        await this.floorPlanRepository.save(floorPlan);
      }
    }
  }

  /**
   * Get parsed DWG geometry for 3D rendering
   */
  async getParsedGeometry(id: string, userId: string) {
    const floorPlan = await this.findOne(id, userId);

    if (!floorPlan.parsedGeometry) {
      throw new NotFoundException('Floor plan has not been parsed yet');
    }

    return {
      floorPlanId: floorPlan.id,
      name: floorPlan.name,
      floor: floorPlan.floor,
      geometry: floorPlan.parsedGeometry,
      dimensions: floorPlan.dimensions,
      scale: floorPlan.scale,
    };
  }

  /**
   * DEVICE MANAGEMENT WITH 3D DATA
   */

  async addDevice(
    id: string,
    userId: string,
    deviceDto: AddDeviceToFloorPlanDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    // Check if device already exists
    const existingDevice = floorPlan.devices.find(
      (d) => d.deviceId === deviceDto.deviceId,
    );
    if (existingDevice) {
      throw new BadRequestException('Device already exists on this floor plan');
    }

    // Create 3D device data
    const device3D: Device3DData = {
      deviceId: deviceDto.deviceId,
      name: deviceDto.name,
      type: deviceDto.type,
      position: deviceDto.position,
      rotation: deviceDto.rotation || { x: 0, y: 0, z: 0 },
      scale: deviceDto.scale || { x: 1, y: 1, z: 1 },
      model3DUrl: deviceDto.model3DUrl,
      animationType: deviceDto.animationType,
      animationConfig: deviceDto.animationConfig || this.getDefaultAnimationConfig(deviceDto.animationType),
      telemetryBindings: deviceDto.telemetryBindings,
      status: 'offline',
    };

    floorPlan.devices.push(device3D);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async updateDevicePosition(
    id: string,
    deviceId: string,
    userId: string,
    position: { x: number; y: number; z: number },
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    const device = floorPlan.devices.find((d) => d.deviceId === deviceId);
    if (!device) {
      throw new NotFoundException('Device not found on floor plan');
    }

    device.position = position;
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async updateDeviceAnimation(
    id: string,
    deviceId: string,
    userId: string,
    animationData: Partial<Device3DData>,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    const device = floorPlan.devices.find((d) => d.deviceId === deviceId);
    if (!device) {
      throw new NotFoundException('Device not found on floor plan');
    }

    // Update animation properties
    if (animationData.animationType !== undefined) {
      device.animationType = animationData.animationType;
    }
    if (animationData.animationConfig) {
      device.animationConfig = {
        ...device.animationConfig,
        ...animationData.animationConfig,
      };
    }
    if (animationData.telemetryBindings) {
      device.telemetryBindings = animationData.telemetryBindings;
    }

    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async removeDevice(
    id: string,
    deviceId: string,
    userId: string,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    floorPlan.devices = floorPlan.devices.filter(
      (d) => d.deviceId !== deviceId,
    );
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  /**
   * Get 3D simulation data for frontend
   */
  async get3DSimulationData(assetId: string, userId: string) {
    const floorPlans = await this.findByAsset(assetId, userId);

    if (floorPlans.length === 0) {
      throw new NotFoundException('No floor plans found for this asset');
    }

    // Get building metadata from first floor plan
    const building3DMetadata = floorPlans[0].building3DMetadata || {
      buildingName: floorPlans[0].building,
      totalFloors: floorPlans.length,
      floorHeight: 3.5,
      buildingDimensions: {
        width: 50,
        length: 30,
        height: floorPlans.length * 3.5,
      },
      floorOrder: floorPlans.map(fp => fp.floor),
    };

    // Compile floor data
    const floors = floorPlans.map((fp, index) => ({
      floorId: fp.id,
      floorName: fp.floor,
      floorNumber: fp.floorNumber || index,
      geometry: fp.parsedGeometry,
      devices: fp.devices,
      zones: fp.zones,
      dimensions: fp.dimensions,
    }));

    return {
      assetId,
      building: building3DMetadata,
      floors,
      totalDevices: floorPlans.reduce((sum, fp) => sum + fp.devices.length, 0),
      totalZones: floorPlans.reduce((sum, fp) => sum + fp.zones.length, 0),
    };
  }

  /**
   * ZONE MANAGEMENT
   */

  async addZone(
    id: string,
    userId: string,
    zoneDto: AddZoneDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    const zone = {
      id: uuidv4(),
      ...zoneDto,
    };

    floorPlan.zones.push(zone);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async updateZone(
    id: string,
    zoneId: string,
    userId: string,
    zoneDto: Partial<AddZoneDto>,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    const zone = floorPlan.zones.find((z) => z.id === zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found on floor plan');
    }

    Object.assign(zone, zoneDto);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async removeZone(
    id: string,
    zoneId: string,
    userId: string,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    floorPlan.zones = floorPlan.zones.filter((z) => z.id !== zoneId);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  /**
   * BUILDING 3D METADATA
   */

  async updateBuilding3DMetadata(
    id: string,
    userId: string,
    metadata: Building3DMetadataDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    floorPlan.building3DMetadata = metadata;
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  /**
   * SETTINGS
   */

  async getSettings(id: string, userId: string) {
    const floorPlan = await this.findOne(id, userId);

    if (!floorPlan.settings) {
      return this.getDefaultSettings();
    }

    return floorPlan.settings;
  }

  async updateSettings(
    id: string,
    userId: string,
    settingsDto: UpdateFloorPlanSettingsDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    floorPlan.settings = {
      ...floorPlan.settings,
      ...settingsDto,
      gridSettings: {
        ...floorPlan.settings?.gridSettings,
        ...settingsDto.gridSettings,
      },
      defaultColors: {
        ...floorPlan.settings?.defaultColors,
        ...settingsDto.defaultColors,
      },
    };

    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async resetSettings(id: string, userId: string): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    floorPlan.settings = this.getDefaultSettings();
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  /**
   * STATISTICS
   */

  async getStatistics(userId: string) {
    const [total, active, draft, processing, failed] = await Promise.all([
      this.floorPlanRepository.count({ where: { userId } }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.ACTIVE },
      }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.DRAFT },
      }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.PROCESSING },
      }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.FAILED },
      }),
    ]);

    const plans = await this.floorPlanRepository.find({ where: { userId } });
    const totalDevices = plans.reduce(
      (sum, plan) => sum + plan.devices.length,
      0,
    );
    const totalZones = plans.reduce((sum, plan) => sum + plan.zones.length, 0);

    // Count unique assets
    const uniqueAssets = new Set(plans.map(p => p.assetId)).size;

    return {
      total,
      active,
      draft,
      processing,
      failed,
      archived: total - active - draft - processing - failed,
      totalDevices,
      totalZones,
      uniqueAssets,
    };
  }

  /**
   * HELPER METHODS
   */

  private getDefaultSettings() {
    return {
      measurementUnit: 'metric' as const,
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
    };
  }

  private getDefaultAnimationConfig(animationType: DeviceAnimationType) {
    const configs = {
      [DeviceAnimationType.SMOKE]: {
        intensity: 0.7,
        speed: 1.0,
        color: '#808080',
        particleCount: 100,
        radius: 2.0,
      },
      [DeviceAnimationType.DOOR_OPEN_CLOSE]: {
        speed: 1.0,
      },
      [DeviceAnimationType.LIGHT_PULSE]: {
        intensity: 0.8,
        speed: 1.5,
        color: '#FFFFFF',
      },
      [DeviceAnimationType.WATER_LEAK]: {
        intensity: 0.6,
        speed: 1.2,
        color: '#0077BE',
        particleCount: 50,
      },
      [DeviceAnimationType.ALARM_FLASH]: {
        intensity: 1.0,
        speed: 2.0,
        color: '#FF0000',
      },
      [DeviceAnimationType.NONE]: {},
    };

    return configs[animationType] || {};
  }

  private calculateBounds(geometry: any): { width: number; height: number } {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    // Check all geometry points
    [...(geometry.walls || []), ...(geometry.rooms || [])].forEach((item: any) => {
      const points = item.points || item.boundaries || [];
      points.forEach((point: any) => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      });
    });

    return {
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  private async deleteFile(fileUrl: string): Promise<void> {
    try {
      const filePath = path.join(process.cwd(), fileUrl);
      await fs.unlink(filePath);
    } catch (error) {
      this.logger.warn(`Failed to delete file ${fileUrl}: ${error.message}`);
    }
  }
}