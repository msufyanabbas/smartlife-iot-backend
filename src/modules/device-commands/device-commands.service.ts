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
  // TWO-WAY RPC HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `GatewayService.sendRpcRequest()` used to publish and return, leaving no
  // trace: a device's RPC history showed nothing, so there was no way to tell
  // afterwards whether a command had been answered, refused or lost. These two
  // methods give an RPC the same audit trail as a queued command.
  //
  // They deliberately do NOT publish to Kafka. `createCommand()` does, because
  // DeviceCommandsConsumer owns delivery for queued commands; an RPC is
  // delivered synchronously by GatewayService over MQTT/CoAP, so handing the
  // same row to the consumer would make it send the command a second time.

  /**
   * Open a history row for an RPC that is about to be published.
   *
   * Status starts at SENDING — not PENDING — because nothing is going to pick
   * this row up off a queue; the caller is sending it right now.
   */
  async createRpcCommand(args: {
    deviceId: string;
    tenantId: string;
    userId: string;
    method: string;
    params?: Record<string, any>;
    timeoutMs: number;
    /** The RPC correlation id, so a response can be traced back to this row. */
    requestId: string;
    /** 'mqtt' | 'coap' — which transport carried the request. */
    transport: string;
  }): Promise<DeviceCommand> {
    const command = this.commandRepository.create({
      deviceId: args.deviceId,
      tenantId: args.tenantId,
      userId: args.userId,
      commandType: args.method,
      params: args.params ?? {},
      priority: 'NORMAL',
      timeout: args.timeoutMs,
      // An RPC is a one-shot request/response; the platform does not re-issue
      // it, so advertising retries here would be a lie in the history view.
      retries: 0,
      status: 'SENDING',
      statusMessage: 'Two-way RPC published; awaiting device response',
      metadata: {
        rpc: true,
        rpcRequestId: args.requestId,
        transport: args.transport,
      },
    });

    return this.commandRepository.save(command);
  }

  /**
   * Record what actually happened to an RPC.
   *
   *   responded + no error → COMPLETED, response under metadata.response
   *   responded + error     → FAILED,   reason in statusMessage
   *   timeout / cancelled   → FAILED,   reason in statusMessage
   *
   * Never throws: the caller is in the middle of answering an HTTP request and
   * a failed history write must not turn a successful RPC into a 500. The
   * failure is logged instead.
   */
  async recordRpcOutcome(
    commandId: string,
    outcome: {
      status: 'response' | 'timeout' | 'cancelled';
      response?: any;
      error?: string;
      durationMs?: number;
      via?: string;
    },
  ): Promise<void> {
    try {
      const command = await this.commandRepository.findOne({
        where: { id: commandId },
      });
      if (!command) return;

      const succeeded = outcome.status === 'response' && !outcome.error;

      command.status = succeeded ? 'COMPLETED' : 'FAILED';
      command.statusMessage = succeeded
        ? 'Device responded'
        : (outcome.error ??
          (outcome.status === 'timeout'
            ? 'Device did not respond before the RPC timeout'
            : 'RPC cancelled before the device responded'));
      command.completedAt = new Date();

      // The device answering at all proves the request reached it.
      if (outcome.status === 'response') command.deliveredAt ??= new Date();

      command.metadata = {
        ...(command.metadata ?? {}),
        rpcStatus: outcome.status,
        ...(outcome.response !== undefined && { response: outcome.response }),
        ...(outcome.durationMs !== undefined && {
          rpcDurationMs: outcome.durationMs,
        }),
        ...(outcome.via && { respondedVia: outcome.via }),
      };

      await this.commandRepository.save(command);
    } catch (error) {
      console.error(
        `Failed to record RPC outcome for command ${commandId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Mark the request as having reached the broker. Called right after a
   * successful publish, before the response arrives.
   */
  async markRpcDelivered(commandId: string): Promise<void> {
    try {
      await this.commandRepository.update(commandId, {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        statusMessage: 'Published to the device; awaiting response',
      });
    } catch (error) {
      console.error(
        `Failed to mark RPC command ${commandId} delivered: ${(error as Error).message}`,
      );
    }
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