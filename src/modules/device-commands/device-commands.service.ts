// src/modules/device-commands/device-commands.service.ts
import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceCommand } from './entities/device-commands.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { CreateCommandDto } from './dto/create-command.dto';
import { AcknowledgeCommandDto } from './dto/acknowledge-command.dto';
import { KafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class DeviceCommandsService {
  constructor(
    @InjectRepository(DeviceCommand)
    private commandRepository: Repository<DeviceCommand>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private readonly kafkaService: KafkaService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  async createCommand(
    createCommandDto: CreateCommandDto,
    userId: string,
    tenantId: string | undefined,
  ): Promise<DeviceCommand> {
    // 1. Verify device exists and belongs to tenant
    const device = await this.deviceRepository.findOne({
      where: { 
        id: createCommandDto.deviceId, 
        tenantId 
      },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // 2. Create command record
    const command = this.commandRepository.create({
      deviceId: createCommandDto.deviceId,
      commandType: createCommandDto.commandType,
      params: createCommandDto.params || {},
      priority: createCommandDto.priority || 'NORMAL',
      timeout: createCommandDto.timeout || 30000,
      retries: 3,
      scheduledFor: createCommandDto.scheduledFor 
        ? new Date(createCommandDto.scheduledFor) 
        : undefined,
      userId,
      tenantId,
      status: createCommandDto.scheduledFor ? 'SCHEDULED' : 'PENDING',
    });

    const savedCommand = await this.commandRepository.save(command);

    // 3. Publish to Kafka for async processing
    await this.kafkaService.sendMessage('device.commands', {
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

    console.log(`✅ Command ${savedCommand.id} published to Kafka`);

    return savedCommand;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET COMMAND STATUS
  // ══════════════════════════════════════════════════════════════════════════

  async getCommandStatus(
    commandId: string,
    tenantId: string | undefined,
  ): Promise<DeviceCommand> {
    const command = await this.commandRepository.findOne({
      where: { id: commandId, tenantId },
      relations: ['device', 'user'],
    });

    if (!command) {
      throw new NotFoundException('Command not found');
    }

    return command;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET DEVICE COMMANDS
  // ══════════════════════════════════════════════════════════════════════════

  async getDeviceCommands(
    deviceId: string,
    tenantId: string | undefined,
    limit: number = 50,
  ): Promise<DeviceCommand[]> {
    return this.commandRepository.find({
      where: { deviceId, tenantId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET USER COMMANDS
  // ══════════════════════════════════════════════════════════════════════════

  async getUserCommands(
    userId: string,
    tenantId: string | undefined,
    limit: number = 100,
  ): Promise<DeviceCommand[]> {
    return this.commandRepository.find({
      where: { userId, tenantId },
      relations: ['device'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANCEL COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  async cancelCommand(
    commandId: string,
    tenantId: string | undefined,
  ): Promise<DeviceCommand> {
    const command = await this.getCommandStatus(commandId, tenantId);

    if (!command.canCancel()) {
      throw new BadRequestException(
        `Cannot cancel command with status: ${command.status}`
      );
    }

    command.status = 'CANCELLED';
    command.statusMessage = 'Cancelled by user';

    return this.commandRepository.save(command);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACKNOWLEDGE (terminal outcome reported after execution)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Closes the loop on a command.
   *
   * DELIVERED only means the payload reached the broker. This records what the
   * device actually did: COMPLETED on success, FAILED when `error` is set.
   * Until this is called, COMPLETED is never reached by any code path.
   *
   * Stored in existing columns so no migration is needed:
   *   response → metadata.response
   *   error    → statusMessage
   */
  async acknowledgeCommand(
    commandId: string,
    tenantId: string | undefined,
    dto: AcknowledgeCommandDto,
  ): Promise<DeviceCommand> {
    const command = await this.commandRepository.findOne({
      where: { id: commandId, tenantId },
    });

    if (!command) {
      throw new NotFoundException('Command not found');
    }

    // A cancelled command was never executed; a second acknowledgement must
    // not overwrite the first outcome.
    if (command.status === 'CANCELLED') {
      throw new BadRequestException('Cannot acknowledge a cancelled command');
    }

    if (command.status === 'COMPLETED' || command.status === 'FAILED') {
      throw new BadRequestException(
        `Command already acknowledged with status: ${command.status}`,
      );
    }

    const failed = Boolean(dto.error);

    command.status = failed ? 'FAILED' : 'COMPLETED';
    command.statusMessage = failed
      ? dto.error
      : 'Acknowledged by device';
    command.completedAt = new Date();

    // A device can acknowledge without the platform having observed the
    // publish (e.g. the broker ack was lost) — record delivery too.
    command.deliveredAt ??= new Date();

    if (dto.response) {
      command.metadata = { ...(command.metadata ?? {}), response: dto.response };
    }

    return this.commandRepository.save(command);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL METHODS (Called by Consumer)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Update command status (called by DeviceCommandsConsumer)
   */
  async updateCommandStatus(
    commandId: string,
    status: DeviceCommand['status'],
    statusMessage?: string,
  ): Promise<void> {
    const updates: any = { status };

    if (statusMessage) {
      updates.statusMessage = statusMessage;
    }

    if (status === 'DELIVERED') {
      updates.deliveredAt = new Date();
    }

    if (status === 'COMPLETED') {
      updates.completedAt = new Date();
    }

    await this.commandRepository.update(commandId, updates);
  }

  /**
   * Update command metadata (called by DeviceCommandsConsumer)
   */
  async updateCommandMetadata(
    commandId: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    await this.commandRepository.update(commandId, { metadata });
  }
}