import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const WIDGET_KINDS = ['light', 'hvac', 'switch', 'sensor', 'scene'] as const;
const TRANSFORM_TYPES = ['boolean', 'threshold', 'valueMap', 'linear'] as const;

export class WidgetActionDto {
  @ApiProperty({
    description: 'Names this action. The action route addresses an action by this id.',
    example: 'on',
  })
  @IsString()
  @MaxLength(48)
  id: string;

  @ApiPropertyOptional({ example: 'Turn on' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Target device. Omit to use the widget\'s own device. A scene\'s actions must each name one.',
  })
  @IsOptional()
  @IsUUID('4')
  deviceId?: string;

  @ApiProperty({
    description: 'The command method sent to the device, e.g. setState.',
    example: 'setState',
  })
  @IsString()
  @MaxLength(64)
  method: string;

  @ApiPropertyOptional({ example: { on: true } })
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'State to show immediately, before the device confirms. Its own telemetry overrides this ' +
      'on the next frame.',
    example: true,
  })
  @IsOptional()
  optimisticState?: string | number | boolean;
}

export class WidgetStateTransformDto {
  @ApiProperty({ enum: TRANSFORM_TYPES })
  @IsIn(TRANSFORM_TYPES as unknown as string[])
  type: (typeof TRANSFORM_TYPES)[number];

  @ApiPropertyOptional({ description: 'threshold: at or above this is ON.' })
  @IsOptional()
  @IsNumber()
  threshold?: number;

  @ApiPropertyOptional({ description: 'valueMap: exact raw value → state.' })
  @IsOptional()
  @IsObject()
  valueMap?: Record<string, string | number | boolean>;

  @ApiPropertyOptional() @IsOptional() @IsNumber() inMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() inMax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() outMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() outMax?: number;

  @ApiPropertyOptional({
    description:
      'Seconds. A reading older than this resolves to unknown rather than its last value — a ' +
      'dead sensor must not leave a lamp drawn on.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  staleAfterSeconds?: number;
}

export class WidgetVisualDto {
  @ApiPropertyOptional({ example: '#fde68a' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ description: '0–1.', example: 0.55 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  intensity?: number;

  @ApiPropertyOptional({
    description: 'Metres. Used when the widget has no zone, so the effect is drawn as a circle.',
    example: 3,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  radiusM?: number;

  @ApiPropertyOptional({ example: 'lightbulb' })
  @IsOptional()
  @IsString()
  @MaxLength(48)
  icon?: string;
}

export class CreateFloorPlanWidgetDto {
  @ApiProperty({ enum: WIDGET_KINDS })
  @IsIn(WIDGET_KINDS as unknown as string[])
  kind: (typeof WIDGET_KINDS)[number];

  @ApiProperty({ example: 'Meeting room downlights' })
  @IsString()
  @MaxLength(160)
  label: string;

  @ApiPropertyOptional({
    description: 'The device this widget reads and commands. Required for every kind but scene.',
  })
  @IsOptional()
  @IsUUID('4')
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'The zone whose area lights up when this widget turns on. Must be a zone of this plan.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  zoneId?: string;

  @ApiProperty({ description: 'Metres, in the drawing\'s own coordinates.' })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Metres, in the drawing\'s own coordinates.' })
  @IsNumber()
  y: number;

  @ApiPropertyOptional({ description: 'Metres above the floor.', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  z?: number;

  @ApiPropertyOptional({
    description: 'Telemetry key reporting the current state.',
    example: 'switch_1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  stateKey?: string;

  @ApiPropertyOptional({ type: WidgetStateTransformDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetStateTransformDto)
  stateTransform?: WidgetStateTransformDto;

  @ApiPropertyOptional({ type: [WidgetActionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WidgetActionDto)
  actions?: WidgetActionDto[];

  @ApiPropertyOptional({ type: WidgetVisualDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetVisualDto)
  visual?: WidgetVisualDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * PATCH. Every field optional.
 *
 * `zoneId: null` and `deviceId: null` are meaningful — they UNBIND — and the
 * service writes an explicit null for them, because TypeORM reads `undefined`
 * as "leave the column alone" and the unbind would otherwise silently do
 * nothing.
 */
export class UpdateFloorPlanWidgetDto extends PartialType(CreateFloorPlanWidgetDto) {}

/**
 * Body for `POST /floor-plans/:id/widgets/:widgetId/action`.
 *
 * It names an ACTION, and nothing else. There is deliberately no `method`,
 * no `params` and no `deviceId` here: those are read from the stored widget.
 * Accepting them would turn a light switch into a general-purpose "send any
 * command to any device" endpoint, reachable by every role the route admits.
 * Same rule, same reason, as the SCADA write-back route (§4n).
 */
export class ExecuteWidgetActionDto {
  @ApiProperty({
    description: 'Which of the widget\'s stored actions to run.',
    example: 'on',
  })
  @IsString()
  @MaxLength(48)
  actionId: string;

  @ApiPropertyOptional({
    description:
      'Wait for the device to answer and report what it said, instead of returning as soon as ' +
      'the command is queued.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  waitForResponse?: boolean;
}

export class ImportWidgetsFromDrawingDto {
  @ApiPropertyOptional({
    enum: WIDGET_KINDS,
    isArray: true,
    description:
      'Which kinds to import. Defaults to lights and HVAC — the two the drawing standard ' +
      'places reliably (E-LITE and M-HVAC-EQPM).',
  })
  @IsOptional()
  @IsArray()
  @IsIn(WIDGET_KINDS as unknown as string[], { each: true })
  kinds?: Array<(typeof WIDGET_KINDS)[number]>;
}
