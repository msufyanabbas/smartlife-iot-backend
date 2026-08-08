// src/modules/schedules/dto/update-schedule.dto.ts
import { PartialType } from '@nestjs/swagger';
import { CreateScheduleDto } from './create-schedule.dto';

/**
 * Every field optional; all validators are preserved.
 *
 * The cross-field validators (`ValidateScheduleTiming`,
 * `ValidateScheduleActionConfig`) short-circuit to `true` when their anchor
 * field is absent from the payload, so a partial update is never rejected for
 * fields it does not touch. `SchedulesService.update()` re-runs both against
 * the *merged* entity, which is what actually guards a PATCH that changes
 * `actionType` without sending a matching `actionConfig`.
 */
export class UpdateScheduleDto extends PartialType(CreateScheduleDto) {}
