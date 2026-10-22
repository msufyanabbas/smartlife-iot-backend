import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsNumber,
  IsDateString,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { toQueryBoolean } from '@common/transformers/query-boolean.transformer';
import {
  AlarmSeverity,
  AlarmStatus,
  AssetProfileType,
} from '@common/enums/index.enum';
import { SortOrder } from '@/common/dto/pagination.dto';

class LocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  longitude?: number;
}

class MaintenanceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  lastServiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  nextServiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  warrantyExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  serviceInterval?: number;
}

export class CreateAssetDto {
  @ApiProperty({ example: 'Building A' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Main Office Building' })
  @IsOptional()
  @IsString()
  label?: string;

  /**
   * @deprecated Ignored since `AssetTypeFromProfile1788700000000`. An asset's
   * type is its profile's type — send `assetProfileId` instead.
   *
   * It stays declared, optional and permissive on purpose. The global
   * `ValidationPipe` runs with `forbidNonWhitelisted: true`, so deleting the
   * property outright would turn every request from an existing client into a
   * 400 — including the mobile app, the Postman collection and the seeders.
   * `AssetsService.stripDeprecatedType()` drops it and logs a warning, so the
   * write is accepted and has no effect.
   *
   * `@IsString()` rather than `@IsEnum(AssetType)`: once the value is
   * discarded there is nothing to gain from rejecting a client over the exact
   * spelling of a field that does nothing.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECATED and ignored. The asset type is inherited from its ' +
      'AssetProfile (`assetProfileId`); sending this logs a warning and ' +
      'changes nothing.',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      "Values for the fields declared by the asset profile's schema, keyed by field key. " +
      'A `floors_array` field (e.g. floorsData) drives GET /assets/:id/floors.',
    example: {
      totalFloors: 3,
      totalArea: 1200,
      buildingType: 'Commercial',
      floorsData: [
        { floorNumber: 1, name: 'Ground Floor', rooms: 12, area: 450 },
        { floorNumber: 2, name: 'First Floor', rooms: 10, area: 400 },
        { floorNumber: 3, name: 'Second Floor', rooms: 8, area: 350 },
      ],
    },
  })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ type: LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @ApiPropertyOptional()
  @IsOptional()
  attributes?: Record<string, any>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerName?: string;

  @ApiPropertyOptional({ type: MaintenanceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceDto)
  maintenance?: MaintenanceDto;
}

export class UpdateAssetDto extends PartialType(CreateAssetDto) { }

/**
 * `GET /assets/search/location`.
 *
 * ── Why this route answered 400 to EVERY possible request ────────────────
 *
 * All three fields are declared `number` and were decorated `@IsString()`.
 * The global pipe runs `enableImplicitConversion: true` (main.ts), so
 * class-transformer reads `design:type = Number` and converts "24.7136" to the
 * number 24.7136 BEFORE validation — at which point `@IsString()` fails. Send
 * a string and it is converted and rejected; send a number and it is rejected.
 * The route was unsatisfiable in both directions:
 *
 *   ?latitude=24.7136  → 400 ["latitude must be a string", …]
 *
 * `@Type(() => Number)` is still declared explicitly rather than relying on
 * the implicit conversion, so this keeps working if that pipe option is ever
 * turned off.
 */
export class SearchAssetQueryDto {
  // ── Required, and not @IsOptional() ────────────────────────────────────
  //
  // All three were optional while `@ApiProperty` declared them required, and
  // the controller coerces with `+`. So `?radius=50` with no coordinates gave
  // `+undefined` → NaN, every distance comparison was false, and the route
  // answered **200 with an empty list** — indistinguishable from "there is
  // nothing within 50 km", which is the worst possible way to report a
  // missing parameter. A 400 naming the field it wants is the whole point of
  // having a DTO.
  @ApiProperty({ example: 24.7136, description: 'Decimal degrees.' })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ example: 46.6753, description: 'Decimal degrees.' })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiProperty({ example: 50, description: 'Kilometres.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  radius: number;
}

export class QueryAssetsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Filter by the asset's type — resolved through its PROFILE, not the
   * deprecated `assets.type` column. `?type=warehouse` therefore means "every
   * asset whose profile is a warehouse profile", which is what the filter
   * always looked like it meant.
   *
   * The vocabulary changed with the source: `AssetProfileType`
   * (building · vehicle · shop · farm · warehouse · hospital · hotel ·
   * factory · custom), not the old `AssetType`
   * (… floor · room · office · equipment · infrastructure · zone · other).
   * `building` and `vehicle` are the only two values in both, so a client
   * filtering on anything else now gets a 400 instead of a list that was
   * keyed off a column nothing maintained.
   */
  @ApiPropertyOptional({
    type: String,
    enum: AssetProfileType,
    enumName: 'AssetProfileType',
    description:
      "Filter by the asset's inherited type (AssetProfile.type).",
  })
  @IsOptional()
  @IsEnum(AssetProfileType)
  type?: AssetProfileType;

  /**
   * `true` returns only assets with no profile — i.e. no resolvable type.
   * Pairs with `type`: the two together are how an operator finds and fixes
   * what the backfill could not classify.
   */
  @ApiPropertyOptional({
    description: 'Only assets with no asset profile (and so no type).',
  })
  @IsOptional()
  // ── Why @Transform and not @IsBoolean alone ────────────────────────────
  //
  // A query string is text, and class-transformer 0.5's implicit boolean
  // conversion is literally `Boolean(value)` — so `Boolean('false')` is TRUE.
  // `?active=false` therefore returned the ACTIVE assets, and
  // `?untyped=false` returned only the untyped one. Passing false did the
  // same thing as passing true.
  //
  // The house pattern is an explicit transform: see
  // `api-monitoring/dto/api-log-filter.dto.ts` and
  // `images/dto/create-image.dto.ts`.
  @Transform(toQueryBoolean)
  @IsBoolean()
  untyped?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Match assets carrying ANY of these tags. Repeat the param for several.',
  })
  @IsOptional()
  // A single `?tags=critical` arrives as a STRING, not an array, so `@IsArray`
  // answered 400 ["tags must be an array"] for the most natural way to call
  // the route. Wrapping one value is what every query-string array needs.
  @Transform(({ value }) =>
    value === undefined || value === null || value === ''
      ? undefined
      : Array.isArray(value)
        ? value
        : [value],
  )
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page: number = 1;

    @ApiPropertyOptional({ description: 'Sort field' })
    @IsString()
    @IsOptional()
    sortBy?: string;
  
    @ApiPropertyOptional({ type: String, enum: SortOrder, enumName: 'SortOrder', default: SortOrder.DESC })
    @IsEnum(SortOrder)
    @IsOptional()
    sortOrder?: SortOrder = SortOrder.DESC;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  limit: number = 10;

    get skip(): number {
    return (this.page - 1) * this.limit;
  }

  get take(): number {
    return this.limit;
  }
}

export class AssignDeviceDto {
  @ApiProperty()
  @IsString()
  deviceId: string;
}

export class BulkAssignDevicesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  deviceIds: string[];
}

/**
 * `PATCH /assets/:id/attributes`.
 *
 * ── Why this route answered 400 to every call ────────────────────────────
 *
 * `attributes` carried only `@ApiProperty()` — a Swagger decorator, which
 * class-validator does not see. With no validation metadata the property is
 * not on the whitelist, `whitelist: true` strips it, and
 * `forbidNonWhitelisted: true` turns that into
 * `["property attributes should not exist"]`. The route could never succeed.
 *
 * `@IsObject()` is the minimum that registers the property. The VALUES stay
 * free-form on purpose: this is a key-value bag for operator-defined
 * attributes, and the asset's typed, schema-validated fields live in
 * `configuration` (§4c), not here.
 */
export class UpdateAttributesDto {
  @ApiProperty({
    description:
      'Free-form attribute bag. MERGED into the asset\'s existing attributes — keys you do not ' +
      'send are left alone. Send null as a value to clear one.',
    example: { hvacZone: 'Zone-A', assetTag: 'HQ-1042' },
  })
  @IsObject()
  attributes: Record<string, any>;
}

export class AssetAlarmsQueryDto {
  @ApiPropertyOptional({ type: String, enum: AlarmStatus, enumName: 'AlarmStatus' })
  @IsOptional()
  @IsEnum(AlarmStatus)
  status?: AlarmStatus;

  @ApiPropertyOptional({ type: String, enum: AlarmSeverity, enumName: 'AlarmSeverity' })
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class AssetHierarchyDto {
  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @IsNumber()
  maxDepth?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  // Boolean("false") === true — see the note on `untyped` above.
  @Transform(toQueryBoolean)
  @IsBoolean()
  includeDevices?: boolean;
}
