import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TriggerType, ActionType } from '../entities/automation.entity';

export class CreateAutomationDto {
  @ApiProperty({ example: 'Temperature Alert Automation' })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'Send alert when temperature exceeds 30°C',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    example: {
      type: 'threshold',
      device: 'device-123',
      attribute: 'temperature',
      operator: '>',
      value: 30,
    },
  })
  @IsObject()
  trigger: {
    type: TriggerType;
    device?: string;
    attribute?: string;
    operator?: string;
    value?: any;
    schedule?: string;
  };

  @ApiProperty({
    example: {
      type: 'notification',
      target: 'user@example.com',
      command: 'send',
      message: 'Temperature alert!',
    },
  })
  @IsObject()
  action: {
    type: ActionType;
    target: string;
    command: string;
    value?: any;
    message?: string;
    url?: string;
  };
}
