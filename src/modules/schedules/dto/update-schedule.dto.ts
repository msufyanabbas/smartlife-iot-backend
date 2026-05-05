// src/modules/schedules/dto/update-schedule.dto.ts
import { PartialType } from '@nestjs/swagger';
import { CreateScheduleDto } from './create-schedule.dto';

// PartialType makes every field optional and preserves all validators,
// including @ValidateScheduleConfiguration — class-validator only runs
// the cross-field validator when BOTH `type` and `configuration` are
// present in the same payload, so partial updates are safe.
export class UpdateScheduleDto extends PartialType(CreateScheduleDto) {}