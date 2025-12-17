// src/modules/devices/services/devices.service.ts
// UPDATED - Flexible topics for different device types + downlink support

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
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
import { generateToken, generateRandomString } from '@/common/utils/helpers';
import { UserRole } from '../users/entities/user.entity';

/**
 * Device Topic Strategy
 * Different device types have different topic patterns
 */
interface DeviceTopicStrategy {
  // Uplink topics (device → platform)
  telemetryTopic: string;
  attributesTopic: string;
  statusTopic: string;
  alertsTopic: string;

  // Downlink topics (platform → device)
  commandsTopic: string;

  // Topic patterns for listening
  uplinkPattern: string[];
}

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private configService: ConfigService,
  ) {}

  /**
   * Create a new device
   */
  async create(
    userId: string,
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

    // Generate device credentials
    const accessToken = generateToken(64);
    const secretKey = `sk_${generateToken(32)}`;

    // Create device
    const device = this.deviceRepository.create({
      ...createDeviceDto,
      deviceKey,
      userId,
      accessToken,
      secretKey,
      status: DeviceStatus.INACTIVE,

      // Store device-specific metadata
      metadata: {
        ...createDeviceDto.metadata,
        // For LoRaWAN devices, store devEUI if provided
        devEUI: createDeviceDto.metadata?.devEUI,
        // Device type for topic strategy
        deviceType: createDeviceDto.metadata?.deviceType || 'generic',
        // Gateway type (milesight, chirpstack, etc.)
        gatewayType: createDeviceDto.metadata?.gatewayType,
      },
    });

    await this.deviceRepository.save(device);

    // Remove sensitive data from response
    const { accessToken: _, secretKey: __, ...deviceData } = device;

    // Generate credentials with proper topics
    const credentials = this.generateCredentials(device);

    return { device: deviceData as Device, credentials };
  }

  /**
   * Generate device credentials with proper topic configuration
   * SMART: Detects device type and returns appropriate topics
   */
  private generateCredentials(device: Device): DeviceCredentialsDto {
    const mqttBrokerUrl =
      this.configService.get('MQTT_BROKER_URL') || 'mqtt://localhost:1883';
    const brokerUrlObj = new URL(mqttBrokerUrl);
    const mqttHost = brokerUrlObj.hostname;
    const mqttPort = parseInt(brokerUrlObj.port) || 1883;

    // Get topic strategy based on device type
    const topicStrategy = this.getDeviceTopicStrategy(device);

    // Build credentials
    const credentials: DeviceCredentialsDto = {
      deviceKey: device.deviceKey,
      accessToken: device.accessToken || undefined,
      secretKey: device.secretKey || undefined,
      mqttBroker: mqttBrokerUrl,
      mqttHost,
      mqttPort,

      // Uplink topics (device publishes here)
      telemetryTopic: topicStrategy.telemetryTopic,
      attributesTopic: topicStrategy.attributesTopic,
      statusTopic: topicStrategy.statusTopic,
      alertsTopic: topicStrategy.alertsTopic,

      // Downlink topic (platform publishes commands here)
      commandsTopic: topicStrategy.commandsTopic,

      // Gateway-specific configuration
      gatewayConfig: {
        clientId: device.deviceKey,
        username: device.accessToken,
        password: device.secretKey,
        host: mqttHost,
        port: mqttPort,

        // For generic MQTT devices
        publishTopic: topicStrategy.telemetryTopic,

        // For Milesight UG65 or other LoRaWAN gateways
        ...(device.metadata?.devEUI && {
          devEUI: device.metadata.devEUI,
          downlinkTopic: topicStrategy.commandsTopic,
        }),

        qos: 1,
      },

      // Include topic patterns for documentation
      uplinkPatterns: topicStrategy.uplinkPattern,
    };

    return credentials;
  }

  /**
   * Get topic strategy based on device type
   * This is where we handle different device/gateway types
   */
  private getDeviceTopicStrategy(device: Device): DeviceTopicStrategy {
    const deviceType = device.metadata?.deviceType || 'generic';
    const gatewayType = device.metadata?.gatewayType;
    const devEUI = device.metadata?.devEUI;

    // ========================================
    // MILESIGHT UG65 GATEWAY
    // ========================================
    if (gatewayType === 'milesight' || deviceType === 'lorawan-milesight') {
      if (!devEUI) {
        throw new BadRequestException(
          'devEUI required for Milesight LoRaWAN devices',
        );
      }

      return {
        // Uplink: Gateway publishes here (CONSTANT)
        telemetryTopic: `application/1/device/${devEUI}/rx`,
        attributesTopic: `application/1/device/${devEUI}/event/up`,
        statusTopic: `application/1/device/${devEUI}/event/status`,
        alertsTopic: `application/1/device/${devEUI}/event/error`,

        // Downlink: Platform publishes commands here (devEUI-specific!)
        commandsTopic: `application/1/device/${devEUI}/tx`,

        // What to listen to
        uplinkPattern: [
          `application/1/device/${devEUI}/rx`,
          `application/1/device/${devEUI}/event/+`,
        ],
      };
    }

    // ========================================
    // CHIRPSTACK (Generic LoRaWAN)
    // ========================================
    if (gatewayType === 'chirpstack' || deviceType === 'lorawan-chirpstack') {
      if (!devEUI) {
        throw new BadRequestException(
          'devEUI required for ChirpStack LoRaWAN devices',
        );
      }

      return {
        // ChirpStack format
        telemetryTopic: `application/+/device/${devEUI}/event/up`,
        attributesTopic: `application/+/device/${devEUI}/event/join`,
        statusTopic: `application/+/device/${devEUI}/event/status`,
        alertsTopic: `application/+/device/${devEUI}/event/error`,

        // ChirpStack downlink
        commandsTopic: `application/+/device/${devEUI}/command/down`,

        uplinkPattern: [
          `application/+/device/${devEUI}/event/up`,
          `application/+/device/${devEUI}/event/+`,
        ],
      };
    }

    // ========================================
    // THINGSBOARD-STYLE (Single topic with credentials)
    // ========================================
    if (deviceType === 'thingsboard' || deviceType === 'mqtt-thingsboard') {
      return {
        // ThingsBoard uses single topics for all devices
        telemetryTopic: 'v1/devices/me/telemetry',
        attributesTopic: 'v1/devices/me/attributes',
        statusTopic: 'v1/devices/me/attributes',
        alertsTopic: 'v1/devices/me/telemetry',

        // Commands use RPC pattern
        commandsTopic: 'v1/devices/me/rpc/request/+',

        uplinkPattern: ['v1/devices/me/telemetry', 'v1/devices/me/attributes'],
      };
    }

    // ========================================
    // GENERIC MQTT DEVICE (Default)
    // ========================================
    return {
      // Standard topic pattern with deviceKey
      telemetryTopic: `devices/${device.deviceKey}/telemetry`,
      attributesTopic: `devices/${device.deviceKey}/attributes`,
      statusTopic: `devices/${device.deviceKey}/status`,
      alertsTopic: `devices/${device.deviceKey}/alerts`,

      // Generic downlink
      commandsTopic: `devices/${device.deviceKey}/commands`,

      uplinkPattern: [
        `devices/${device.deviceKey}/telemetry`,
        `devices/${device.deviceKey}/+`,
      ],
    };
  }

  /**
   * Send downlink command to device
   * Handles different gateway types automatically
   */
  async sendCommand(
    deviceId: string,
    user: User,
    command: {
      type: string;
      params?: any;
      port?: number; // For LoRaWAN
      confirmed?: boolean; // For LoRaWAN
    },
  ): Promise<void> {
    const device = await this.findOne(deviceId, user);

    const deviceType = device.metadata?.deviceType || 'generic';
    const gatewayType = device.metadata?.gatewayType;

    // Get downlink topic
    const topicStrategy = this.getDeviceTopicStrategy(device);
    const downlinkTopic = topicStrategy.commandsTopic;

    // Build payload based on gateway type
    let payload: any;

    // Milesight UG65 downlink format
    if (gatewayType === 'milesight') {
      payload = {
        devEUI: device.metadata?.devEUI,
        fPort: command.port || 85,
        confirmed: command.confirmed || false,
        data: this.encodeCommandForMilesight(command),
      };
    }
    // ChirpStack downlink format
    else if (gatewayType === 'chirpstack') {
      payload = {
        devEUI: device.metadata?.devEUI,
        confirmed: command.confirmed || false,
        fPort: command.port || 1,
        data: Buffer.from(JSON.stringify(command)).toString('base64'),
      };
    }
    // Generic MQTT
    else {
      payload = {
        command: command.type,
        params: command.params,
        timestamp: Date.now(),
      };
    }

    // Publish via MQTT (you'll need MQTT service here)
    // await this.mqttService.publish(downlinkTopic, payload);

    console.log(`📤 Sending command to device ${device.deviceKey}`);
    console.log(`📍 Topic: ${downlinkTopic}`);
    console.log(`📦 Payload:`, payload);

    // TODO: Integrate with your MQTT service to actually send
    // For now, just log
  }

  /**
   * Encode command for Milesight devices
   * Example: Turn on/off, set brightness, etc.
   */
  private encodeCommandForMilesight(command: any): string {
    // This depends on your specific device (WS558, etc.)
    // Example for WS558 light controller:

    if (command.type === 'set_light') {
      // Format: 0xFF 0x0B 0x01 (on) or 0x00 (off)
      const status = command.params.on ? 0x01 : 0x00;
      return Buffer.from([0xff, 0x0b, status]).toString('hex');
    }

    if (command.type === 'set_brightness') {
      // Format: 0xFF 0x0C brightness_value
      const brightness = Math.min(255, Math.max(0, command.params.brightness));
      return Buffer.from([0xff, 0x0c, brightness]).toString('hex');
    }

    // Default: return params as hex if it's already hex
    if (typeof command.params === 'string') {
      return command.params;
    }

    // Or encode as JSON base64
    return Buffer.from(JSON.stringify(command.params)).toString('base64');
  }

  // ==========================================
  // YOUR EXISTING METHODS (keep as is)
  // ==========================================

  async findAll(
    user: User,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<Device>> {
    const { page, limit, search, sortBy, sortOrder } = paginationDto;


    const queryBuilder = this.deviceRepository.createQueryBuilder('device');

    // ========================================
    // CUSTOMER FILTERING LOGIC
    // ========================================
    if (user.role === UserRole.CUSTOMER_USER) {
      // Customer users only see their customer's devices
      if (!user.customerId) {
        return PaginatedResponseDto.create([], page, limit, 0);
      }
      queryBuilder.andWhere('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      // Tenant admins see all devices in their tenant
      queryBuilder.andWhere('device.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }
    // SUPER_ADMIN sees everything (no filter)

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

  async findOne(id: string, user: User): Promise<Device> {
    const queryBuilder = this.deviceRepository.createQueryBuilder('device')
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
        'accessToken',
        'secretKey',
        'metadata',
      ],
    });

    if (!device) {
      throw new NotFoundException(`Device with key ${deviceKey} not found`);
    }

    return device;
  }

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

  async deactivate(id: string, user: User): Promise<Device> {
    const device = await this.findOne(id, user);
    device.status = DeviceStatus.INACTIVE;
    await this.deviceRepository.save(device);
    return device;
  }

  async remove(id: string, user: User): Promise<void> {
    const device = await this.findOne(id, user);
    await this.deviceRepository.softRemove(device);
  }

  async updateLastSeen(deviceKey: string): Promise<void> {
    await this.deviceRepository.update(
      { deviceKey },
      { lastSeenAt: new Date() },
    );
  }

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
    // SUPER_ADMIN: no filter

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

  private async countOnlineDevices(userId: string): Promise<number> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.deviceRepository
      .createQueryBuilder('device')
      .where('device.userId = :userId', { userId })
      .andWhere('device.lastSeenAt > :fiveMinutesAgo', { fiveMinutesAgo })
      .getCount();
  }

  private async getDevicesByType(user: User): Promise<Record<string, number>> {
    const queryBuilder = this.deviceRepository
      .createQueryBuilder('device')
      .select('device.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('device.type');

    // Apply customer filtering
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

  async verifyCredentials(
    deviceKey: string,
    accessToken: string,
  ): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
      select: ['id', 'deviceKey', 'name', 'status', 'userId', 'accessToken'],
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.accessToken !== accessToken) {
      throw new ForbiddenException('Invalid device credentials');
    }

    if (device.status !== DeviceStatus.ACTIVE) {
      throw new ForbiddenException('Device is not active');
    }

    return device;
  }

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

  async getCredentials(
    id: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    const device = await this.findOne(id, user);
     const deviceWithCreds = await this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id = :id', { id })
      .addSelect(['device.accessToken', 'device.secretKey', 'device.metadata'])
      .getOne();

    if (!deviceWithCreds) {
      throw new NotFoundException(`Device with ID ${id} not found`);
    }

    return this.generateCredentials(deviceWithCreds);
  }

  async regenerateCredentials(
    id: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    const device = await this.findOne(id, user);

    const accessToken = generateToken(64);
    const secretKey = `sk_${generateToken(32)}`;

    device.accessToken = accessToken;
    device.secretKey = secretKey;

    await this.deviceRepository.save(device);

    return this.getCredentials(id, user);
  }

  async unassignFromCustomer(deviceId: string, user: User): Promise<Device> {
    // Only admins can unassign
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
   * ============================================
   * Assign device to customer
   * ============================================
   */
  async assignToCustomer(
    deviceId: string,
    customerId: string,
    user: User,
  ): Promise<Device> {
    // Only admins can assign devices to customers
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
   * ============================================
   * Get devices by customer
   * ============================================
   */
  async findByCustomer(customerId: string, user: User): Promise<Device[]> {
    // Validate customer access
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

}
