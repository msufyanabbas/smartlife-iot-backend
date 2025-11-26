// src/modules/device-commands/dto/command-response.dto.ts

export class CommandResponseDto {
  id: string;
  deviceId: string;
  commandType: string;
  status: string;
  statusMessage?: string;
  createdAt: Date;
  deliveredAt?: Date;
  completedAt?: Date;
}
