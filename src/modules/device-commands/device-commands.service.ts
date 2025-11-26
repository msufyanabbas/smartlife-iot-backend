// src/modules/device-commands/device-commands.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { Device } from '../devices/entities/device.entity';
import { CreateCommandDto } from './dto/create-command.dto';
import { kafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class DeviceCommandsService {
  constructor(
    @InjectRepository(DeviceCommand)
    private commandRepository: Repository<DeviceCommand>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
  ) {}

  /**
   * Create and send command to device
   */
  async createCommand(
    createCommandDto: CreateCommandDto,
    userId: string,
    tenantId: string,
  ): Promise<DeviceCommand> {
    // 1. Verify device exists
    const device = await this.deviceRepository.findOne({
      where: { id: createCommandDto.deviceId, tenantId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // 2. Create command record
    const command = this.commandRepository.create({
      ...createCommandDto,
      userId,
      tenantId,
      status: 'PENDING',
      priority: createCommandDto.priority || 'NORMAL',
      timeout: createCommandDto.timeout || 30000,
      retries: 3,
      scheduledFor: createCommandDto.scheduledFor
        ? new Date(createCommandDto.scheduledFor)
        : undefined,
    });

    const savedCommand = await this.commandRepository.save(command);

    // 3. Send to Kafka for processing
    await kafkaService.sendMessage('device.commands', {
      id: savedCommand.id,
      deviceId: savedCommand.deviceId,
      deviceKey: device.deviceKey,
      tenantId: savedCommand.tenantId,
      userId: savedCommand.userId,
      commandType: savedCommand.commandType,
      params: savedCommand.params,
      priority: savedCommand.priority,
      timeout: savedCommand.timeout,
      retries: savedCommand.retries,
      createdAt: savedCommand.createdAt.getTime(),
      scheduledFor: savedCommand.scheduledFor?.getTime(),
    });

    console.log(`✅ Command ${savedCommand.id} sent to Kafka`);

    return savedCommand;
  }

  /**
   * Get command status
   */
  async getCommandStatus(
    commandId: string,
    tenantId: string,
  ): Promise<DeviceCommand> {
    const command = await this.commandRepository.findOne({
      where: { id: commandId, tenantId },
      relations: ['device'],
    });

    if (!command) {
      throw new NotFoundException('Command not found');
    }

    return command;
  }

  /**
   * Get all commands for a device
   */
  async getDeviceCommands(
    deviceId: string,
    tenantId: string,
    limit: number = 50,
  ): Promise<DeviceCommand[]> {
    return this.commandRepository.find({
      where: { deviceId, tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get all commands for user
   */
  async getUserCommands(
    userId: string,
    tenantId: string,
    limit: number = 100,
  ): Promise<DeviceCommand[]> {
    return this.commandRepository.find({
      where: { userId, tenantId },
      relations: ['device'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Cancel pending command
   */
  async cancelCommand(
    commandId: string,
    tenantId: string,
  ): Promise<DeviceCommand> {
    const command = await this.getCommandStatus(commandId, tenantId);

    if (!['PENDING', 'QUEUED', 'SCHEDULED'].includes(command.status)) {
      throw new Error('Cannot cancel command in current status');
    }

    command.status = 'FAILED';
    command.statusMessage = 'Cancelled by user';

    return this.commandRepository.save(command);
  }
}
