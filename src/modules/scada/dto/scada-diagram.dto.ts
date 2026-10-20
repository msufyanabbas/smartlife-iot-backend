// src/modules/scada/dto/scada-diagram.dto.ts
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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
import { PaginationDto } from '@common/dto/pagination.dto';
import {
  SCADA_BINDABLE_PROPERTIES,
  SCADA_BINDING_SOURCES,
  SCADA_SYMBOL_KEYS,
  SCADA_TRANSFORM_KINDS,
  type ScadaBindableProperty,
  type ScadaBindingSource,
  type ScadaTransform,
  type ScadaTransformKind,
} from '../scada-symbol.catalogue';

/**
 * The validation here is deliberately structural only — shapes, enums and
 * ranges. Whether a binding's transform outputs a state the symbol actually
 * has is a question about the catalogue, and `ScadaService` answers it with
 * `validateScadaBinding()` after the pipe has run. Doing it in a decorator
 * would need the symbol key of the enclosing element, which a per-field
 * validator cannot see.
 *
 * `forbidNonWhitelisted: true` is global (see main.ts), so every property the
 * editor sends has to be declared here or the save 400s. That is why the
 * nested DTOs are spelled out rather than typed as `object`.
 */

class ScadaThresholdBandDto {
  @IsIn(['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'between'])
  operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'between';

  @IsNumber() value: number;
  @IsOptional() @IsNumber() value2?: number;
  @IsString() @MaxLength(64) output: string;
}

class ScadaTransformDto implements ScadaTransform {
  @IsIn(SCADA_TRANSFORM_KINDS as unknown as string[])
  kind: ScadaTransformKind;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaThresholdBandDto)
  bands?: ScadaThresholdBandDto[];

  @IsOptional() @IsObject() map?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(64) fallback?: string;
  @IsOptional() @IsString() @MaxLength(64) whenTrue?: string;
  @IsOptional() @IsString() @MaxLength(64) whenFalse?: string;
  @IsOptional() @IsNumber() inMin?: number;
  @IsOptional() @IsNumber() inMax?: number;
  @IsOptional() @IsNumber() outMin?: number;
  @IsOptional() @IsNumber() outMax?: number;
  @IsOptional() @IsBoolean() clamp?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(8) decimals?: number;
  @IsOptional() @IsString() @MaxLength(16) unit?: string;
  @IsOptional() @IsString() @MaxLength(16) prefix?: string;
}

class ScadaBindingDto {
  @IsString() @MaxLength(64) id: string;

  @IsIn(SCADA_BINDABLE_PROPERTIES as unknown as string[])
  property: ScadaBindableProperty;

  @IsIn(SCADA_BINDING_SOURCES as unknown as string[])
  source: ScadaBindingSource;

  // A uuid, validated as one so a crafted non-uuid cannot reach a raw query.
  @IsOptional() @IsUUID() deviceId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) key?: string | null;
  @IsOptional() @IsIn(['client', 'server', 'shared']) scope?:
    | 'client'
    | 'server'
    | 'shared'
    | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScadaTransformDto)
  transform?: ScadaTransformDto | null;

  @IsOptional() @IsInt() @Min(1) @Max(86400) staleAfterSeconds?: number | null;
  @IsOptional() @IsString() @MaxLength(64) staleState?: string | null;
  @IsOptional() @IsString() @MaxLength(120) label?: string | null;
}

class ScadaActionDto {
  @IsString() @MaxLength(64) id: string;
  @IsUUID() deviceId: string;
  @IsString() @MaxLength(120) method: string;
  @IsOptional() @IsObject() params?: Record<string, unknown> | null;
  @IsOptional() @IsBoolean() rpc?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(300000) timeoutMs?: number | null;
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsString() @MaxLength(300) confirmMessage?: string | null;
  @IsOptional() @IsString() @MaxLength(120) label?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledStates?: string[] | null;
}

class ScadaElementDto {
  @IsString() @MaxLength(64) id: string;

  // Checked against the catalogue here, not just in the service: an unknown
  // symbol key renders as nothing at all, and the editor would have no way to
  // tell the operator which element vanished.
  @IsIn(SCADA_SYMBOL_KEYS)
  symbolKey: string;

  @IsNumber() x: number;
  @IsNumber() y: number;
  @IsNumber() @Min(-360) @Max(360) rotation: number;
  @IsNumber() @Min(0.05) @Max(20) scale: number;
  @IsInt() @Min(-10000) @Max(10000) z: number;

  @IsOptional() @IsString() @MaxLength(160) label?: string | null;
  @IsOptional() @IsIn(['top', 'bottom', 'left', 'right', 'none'])
  labelPosition?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  @IsOptional() @IsString() @MaxLength(64) defaultState?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaBindingDto)
  bindings: ScadaBindingDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ScadaActionDto)
  action?: ScadaActionDto | null;

  @IsOptional() @IsUUID() linkDiagramId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsBoolean() locked?: boolean;
}

class ScadaWaypointDto {
  @IsNumber() x: number;
  @IsNumber() y: number;
}

class ScadaConnectionDto {
  @IsString() @MaxLength(64) id: string;
  @IsString() @MaxLength(64) fromElementId: string;
  @IsString() @MaxLength(64) fromPort: string;
  @IsString() @MaxLength(64) toElementId: string;
  @IsString() @MaxLength(64) toPort: string;

  @IsIn(['straight', 'orthogonal', 'curved'])
  routing: 'straight' | 'orthogonal' | 'curved';

  @IsIn(['pipe', 'wire', 'signal', 'duct'])
  kind: 'pipe' | 'wire' | 'signal' | 'duct';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaWaypointDto)
  waypoints?: ScadaWaypointDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaBindingDto)
  bindings?: ScadaBindingDto[];

  @IsOptional() @IsString() @MaxLength(120) label?: string | null;
  @IsOptional() @IsString() @MaxLength(32) colour?: string | null;
  @IsOptional() @IsNumber() @Min(0.5) @Max(40) width?: number | null;
}

class ScadaBackgroundDto {
  @IsOptional() @IsString() @MaxLength(32) colour?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(400) grid?: number | null;
  @IsOptional() @IsBoolean() snap?: boolean | null;
}

export class CreateScadaDiagramDto {
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() customerId?: string;

  @IsOptional() @IsInt() @Min(200) @Max(20000) width?: number;
  @IsOptional() @IsInt() @Min(200) @Max(20000) height?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScadaBackgroundDto)
  background?: ScadaBackgroundDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaElementDto)
  elements?: ScadaElementDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScadaConnectionDto)
  connections?: ScadaConnectionDto[];

  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];

  @IsOptional() @IsInt() @Min(500) @Max(600000) refreshIntervalMs?: number;
}

/**
 * Update is a full REPLACE of whatever it names, including the arrays.
 *
 * Omitting `elements` leaves them alone; sending `elements: []` empties the
 * canvas. That distinction matters because the editor PATCHes the whole graph
 * in one request (same reasoning as `PUT /rule-chains/:id/metadata`), while
 * the list page PATCHes only `name`, and neither should be able to clear the
 * other's data by accident.
 */
export class UpdateScadaDiagramDto extends CreateScadaDiagramDto {
  @IsOptional() @IsString() @MaxLength(160) declare name: string;

  /**
   * The revision the editor loaded. When it is behind the stored one the save
   * is refused with 409 rather than overwriting someone else's canvas. Omit it
   * to force the write.
   */
  @IsOptional() @IsInt() @Min(1) expectedRevision?: number;
}

export class ScadaDiagramQueryDto extends PaginationDto {
  @IsOptional() @IsUUID() customerId?: string;

  /** 'true' / 'false' as a query string; transformed in the service. */
  @IsOptional() @IsIn(['true', 'false']) published?: string;

  @IsOptional() @IsString() @MaxLength(64) tag?: string;
}

export class DuplicateScadaDiagramDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
}

export class PublishScadaDiagramDto {
  @IsBoolean() published: boolean;
}

/**
 * Preview a transform against a value without touching a device.
 *
 * The editor calls this while the operator is typing thresholds, so they can
 * see 73.4 → "high" before saving. It is the only place the server's own
 * evaluator is exposed, and it exists so the frontend's copy can be checked
 * against it rather than trusted.
 */
export class EvaluateBindingDto {
  @IsIn(SCADA_SYMBOL_KEYS) symbolKey: string;

  @IsIn(SCADA_BINDABLE_PROPERTIES as unknown as string[])
  property: ScadaBindableProperty;

  @ValidateNested()
  @Type(() => ScadaTransformDto)
  transform: ScadaTransformDto;

  /** The raw reading. Any JSON scalar. */
  @IsOptional()
  value?: string | number | boolean | null;
}

export class ExecuteScadaActionDto {
  /** Overrides for the action's declared params, merged over them. */
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}
