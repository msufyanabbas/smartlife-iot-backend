// src/modules/devices/devices.service.ts
// UPDATED - Integrated with DeviceCredentialsService

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Device, User } from '@modules/index.entities';
import { DeviceStatus } from './entities/device.entity';
import { CreateDeviceDto } from '@modules/devices/dto/create-device.dto';
import { UpdateDeviceDto } from '@modules/devices/dto/update-device.dto';
import { DeviceCredentialsDto } from '@modules/devices/dto/device-credentials.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '@/common/dto/pagination.dto';
import { generateRandomString } from '@/common/utils/helpers';
import { UserRole } from '@common/enums/index.enum';
import { DeviceCredentialsService } from './device-credentials.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from '../users/users.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);
  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private configService: ConfigService,
    private userService: UsersService,
     private eventEmitter: EventEmitter2,
    private credentialsService: DeviceCredentialsService,
    private subscriptionsService: SubscriptionsService,
  ) {}

  /**
   * Create a new device WITH credentials
   */
  async create(
    user: User,
    createDeviceDto: CreateDeviceDto,
  ): Promise<{ device: Device; credentials: DeviceCredentialsDto }> {
    // Generate unique device key
    const deviceKey = `dev_${generateRandomString(16)}`;

    // Check if device key already exists
    const existingDevice = await this.deviceRepository.findOne({
      where: { deviceKey },
    });

    if (existingDevice) {
      throw new ConflictException('Device key collision. Please try again.');
    }

    // Create device
    const device = this.deviceRepository.create({
      ...createDeviceDto,
      deviceKey,
      userId: user.id,
      status: DeviceStatus.INACTIVE,
      tenantId: user.tenantId,

      // Store device-specific metadata
      metadata: {
        ...createDeviceDto.metadata,
        devEUI: createDeviceDto.metadata?.devEUI,
        deviceType: createDeviceDto.metadata?.deviceType || 'generic',
        gatewayType: createDeviceDto.metadata?.gatewayType,
        manufacturer: createDeviceDto.metadata?.manufacturer,
        model: createDeviceDto.metadata?.model,
        codecId: createDeviceDto.metadata?.codecId,
      },
    });

    const savedDevice = await this.deviceRepository.save(device);

    this.subscriptionsService.incrementTenantUsage(
      user.tenantId as any,
      "devices",
      1
    );

    // Create credentials for the device
    await this.credentialsService.createCredentials(savedDevice);

    // Get full MQTT configuration
    const credentials = await this.credentialsService.getMqttConfiguration(
      savedDevice.id,
      { id: user.id } as User,
    );

    return { device: savedDevice, credentials };
  }

  /**
   * Find all devices with pagination
   */
  async findAll(
    user: User,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<Device>> {
    const { page, limit, search, sortBy, sortOrder } = paginationDto;

    const queryBuilder = this.deviceRepository.createQueryBuilder('device');

    // Customer filtering logic
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return PaginatedResponseDto.create([], page, limit, 0);
      }
      queryBuilder.andWhere('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('device.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    if (search) {
      queryBuilder.andWhere(
        '(device.name ILIKE :search OR device.description ILIKE :search OR device.deviceKey ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const sortField = sortBy || 'createdAt';
    const sortDirection = sortOrder || 'DESC';
    queryBuilder.orderBy(`device.${sortField}`, sortDirection);

    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [devices, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(devices, page, limit, total);
  }

  /**
   * Find one device
   */
  async findOne(id: string, user: User): Promise<Device> {
    const queryBuilder = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id = :id', { id });

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        throw new ForbiddenException('No customer assigned');
      }
      queryBuilder.andWhere('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('device.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const device = await queryBuilder.getOne();

    if (!device) {
      throw new NotFoundException(`Device with ID ${id} not found`);
    }

    return device;
  }

  /**
   * Find device by device key (used by MQTT gateway)
   */
  async findByDeviceKey(deviceKey: string): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
      select: [
        'id',
        'deviceKey',
        'name',
        'type',
        'status',
        'userId',
        'tenantId',
        'metadata',
      ],
    });

    if (!device) {
      throw new NotFoundException(`Device with key ${deviceKey} not found`);
    }

    return device;
  }

  /**
   * Update device
   */
  async update(
    id: string,
    user: User,
    updateDeviceDto: UpdateDeviceDto,
  ): Promise<Device> {
    const device = await this.findOne(id, user);
    Object.assign(device, updateDeviceDto);
    await this.deviceRepository.save(device);
    return device;
  }

  /**
   * Activate device
   */
  async activate(id: string, user: User): Promise<Device> {
    const device = await this.findOne(id, user);

    if (device.status === DeviceStatus.ACTIVE) {
      throw new BadRequestException('Device is already active');
    }

    device.status = DeviceStatus.ACTIVE;
    device.activatedAt = new Date();
    await this.deviceRepository.save(device);
    return device;
  }

  /**
   * Deactivate device
   */
  async deactivate(id: string, user: User): Promise<Device> {
    const device = await this.findOne(id, user);
    device.status = DeviceStatus.INACTIVE;
    await this.deviceRepository.save(device);
    return device;
  }

  /**
   * Delete device (and its credentials)
   */
  async remove(id: string, user: User): Promise<void> {
    const device = await this.findOne(id, user);
    
    // Delete credentials first
    await this.credentialsService.deleteByDeviceId(device.id);
    
    // Then delete device
    await this.deviceRepository.softRemove(device);
  }

  /**
   * Update activity
   */
  async updateActivity(deviceKey: string): Promise<void> {
    await this.deviceRepository.increment({ deviceKey }, 'messageCount', 1);

    await this.deviceRepository.update(
      { deviceKey },
      {
        lastActivityAt: new Date(),
        lastSeenAt: new Date(),
      },
    );
  }

  /**
   * Get device statistics
   */
  async getStatistics(user: User): Promise<any> {
    const queryBuilder = this.deviceRepository.createQueryBuilder('device');

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return this.getEmptyStatistics();
      }
      queryBuilder.where('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.where('device.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const [
      totalDevices,
      activeDevices,
      inactiveDevices,
      offlineDevices,
    ] = await Promise.all([
      queryBuilder.getCount(),
      queryBuilder
        .clone()
        .andWhere('device.status = :status', { status: DeviceStatus.ACTIVE })
        .getCount(),
      queryBuilder
        .clone()
        .andWhere('device.status = :status', { status: DeviceStatus.INACTIVE })
        .getCount(),
      queryBuilder
        .clone()
        .andWhere('device.status = :status', { status: DeviceStatus.OFFLINE })
        .getCount(),
    ]);

    // Get online devices (seen in last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const onlineDevices = await queryBuilder
      .clone()
      .andWhere('device.lastSeenAt > :fiveMinutesAgo', { fiveMinutesAgo })
      .getCount();

    // Get devices by type
    const devicesByType = await this.getDevicesByType(user);

    return {
      totalDevices,
      activeDevices,
      inactiveDevices,
      offlineDevices,
      onlineDevices,
      devicesByType,
      devicesByStatus: {
        active: activeDevices,
        inactive: inactiveDevices,
        offline: offlineDevices,
      },
    };
  }

  private getEmptyStatistics() {
    return {
      totalDevices: 0,
      activeDevices: 0,
      inactiveDevices: 0,
      offlineDevices: 0,
      onlineDevices: 0,
      devicesByType: {},
      devicesByStatus: { active: 0, inactive: 0, offline: 0 },
    };
  }

  private async getDevicesByType(user: User): Promise<Record<string, number>> {
    const queryBuilder = this.deviceRepository
      .createQueryBuilder('device')
      .select('device.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('device.type');

    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return {};
      }
      queryBuilder.where('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.where('device.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const devices = await queryBuilder.getRawMany();

    return devices.reduce((acc, { type, count }) => {
      acc[type] = parseInt(count);
      return acc;
    }, {});
  }

  /**
   * Verify device credentials (called by MQTT gateway)
   */
  async verifyCredentials(
    credentialsId: string,
    credentialsValue?: string,
  ): Promise<Device> {
    const { device } = await this.credentialsService.verifyCredentials(
      credentialsId,
      credentialsValue,
    );
    return device;
  }

  /**
   * Bulk update device status
   */
  async bulkUpdateStatus(
    deviceIds: string[],
    userId: string,
    status: DeviceStatus,
  ): Promise<void> {
    const devices = await this.deviceRepository.find({
      where: { id: In(deviceIds), userId },
    });

    if (devices.length !== deviceIds.length) {
      throw new BadRequestException(
        'Some devices not found or do not belong to user',
      );
    }

    await this.deviceRepository.update({ id: In(deviceIds) }, { status });
  }

  /**
   * Get device credentials
   */
  async getCredentials(id: string, user: User): Promise<DeviceCredentialsDto> {
    await this.findOne(id, user); // Verify access
    return this.credentialsService.getMqttConfiguration(id, user);
  }

  /**
   * Regenerate device credentials
   */
  async regenerateCredentials(
    id: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    return this.credentialsService.regenerateCredentials(id, user);
  }

  /**
   * Assign device to customer
   */
  async assignToCustomer(
    deviceId: string,
    customerId: string,
    user: User,
  ): Promise<Device> {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can assign devices to customers');
    }

    const device = await this.findOne(deviceId, user);
    device.customerId = customerId;
    return await this.deviceRepository.save(device);
  }

  /**
   * Unassign device from customer
   */
  async unassignFromCustomer(deviceId: string, user: User): Promise<Device> {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can unassign devices');
    }

    const device = await this.findOne(deviceId, user);
    device.customerId = undefined;
    return await this.deviceRepository.save(device);
  }

  /**
   * Get devices by customer
   */
  async findByCustomer(customerId: string, user: User): Promise<Device[]> {
    if (user.role === UserRole.CUSTOMER_USER) {
      if (user.customerId !== customerId) {
        throw new ForbiddenException('Access denied to this customer');
      }
    }

    return await this.deviceRepository.find({
      where: { customerId },
      order: { name: 'ASC' },
    });
  }

  /**
 * ✅ Handle device going offline
 */
private async handleDeviceOffline(device: Device, user: User): Promise<void> {
  this.eventEmitter.emit('device.offline', { device, user });
  this.logger.warn(`Device ${device.name} (${device.id}) went offline`);
}

/**
 * ✅ Handle device coming online
 */
private async handleDeviceOnline(device: Device, user: User): Promise<void> {
  this.eventEmitter.emit('device.connected', { device, user });
  this.logger.log(`Device ${device.name} (${device.id}) is now online`);
}

/**
 * ✅ Update updateLastSeen to emit events
 */
async updateLastSeen(deviceKey: string): Promise<void> {
  const device = await this.findByDeviceKey(deviceKey);
  
  const wasOffline = device.status === DeviceStatus.OFFLINE;
  
  await this.deviceRepository.update(
    { deviceKey },
    { 
      lastSeenAt: new Date(),
      status: DeviceStatus.ACTIVE 
    },
  );

  if (wasOffline) {
    const user = await this.userService.findOne(device.userId);
    await this.handleDeviceOnline(device, user);
  }
}

/**
 * ✅ Add a cron job to check for offline devices
 */
@Cron(CronExpression.EVERY_5_MINUTES)
async checkOfflineDevices(): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  
  const devices = await this.deviceRepository.find({
    where: {
      status: DeviceStatus.ACTIVE,
      lastSeenAt: LessThan(fiveMinutesAgo),
    },
  });

  for (const device of devices) {
    device.status = DeviceStatus.OFFLINE;
    await this.deviceRepository.save(device);
    
    const user = await this.userService.findOne(device.userId);
    await this.handleDeviceOffline(device, user);
  }
  
  if (devices.length > 0) {
    this.logger.log(`Marked ${devices.length} devices as offline`);
  }
}
}