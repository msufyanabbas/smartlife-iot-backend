import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FloorPlan, FloorPlanStatus } from './entities/floor-plan.entity';
import {
  CreateFloorPlanDto,
  AddDeviceToFloorPlanDto,
  AddZoneDto,
} from './dto/create-floor-plan.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FloorPlansService {
  constructor(
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
  ) {}

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
        '(floorPlan.name ILIKE :search OR floorPlan.building ILIKE :search)',
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
    await this.floorPlanRepository.softRemove(floorPlan);
  }

  async uploadImage(
    id: string,
    userId: string,
    imageUrl: string,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);
    floorPlan.imageUrl = imageUrl;
    floorPlan.updatedBy = userId;
    return await this.floorPlanRepository.save(floorPlan);
  }

  async addDevice(
    id: string,
    userId: string,
    deviceDto: AddDeviceToFloorPlanDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, userId);

    // Add device to the devices array
    floorPlan.devices.push(deviceDto);
    floorPlan.updatedBy = userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async updateDevicePosition(
    id: string,
    deviceId: string,
    userId: string,
    position: { x: number; y: number },
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

  async getStatistics(userId: string) {
    const [total, active, draft] = await Promise.all([
      this.floorPlanRepository.count({ where: { userId } }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.ACTIVE },
      }),
      this.floorPlanRepository.count({
        where: { userId, status: FloorPlanStatus.DRAFT },
      }),
    ]);

    // Get total devices and zones
    const plans = await this.floorPlanRepository.find({ where: { userId } });
    const totalDevices = plans.reduce(
      (sum, plan) => sum + plan.devices.length,
      0,
    );
    const totalZones = plans.reduce((sum, plan) => sum + plan.zones.length, 0);

    return {
      total,
      active,
      draft,
      archived: total - active - draft,
      totalDevices,
      totalZones,
    };
  }
}
