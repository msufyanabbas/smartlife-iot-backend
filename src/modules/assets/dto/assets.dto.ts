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
import { Type } from 'class-transformer';
import { AlarmSeverity, AlarmStatus, AssetType } from '@common/enums/index.enum';
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

  @ApiProperty({ type: String, enum: AssetType, enumName: 'AssetType', default: AssetType.OTHER })
  @IsEnum(AssetType)
  type: AssetType;

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

export class SearchAssetQueryDto {
  @ApiProperty()
  @IsOptional()
  @IsString()
  latitude: number;

  @ApiProperty()
  @IsOptional()
  @IsString()
  longitude: number;

  @ApiProperty()
  @IsOptional()
  @IsString()
  radius: number;
}

export class QueryAssetsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ type: String, enum: AssetType, enumName: 'AssetType' })
  @IsOptional()
  @IsEnum(AssetType)
  type?: AssetType;

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
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
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

export class UpdateAttributesDto {
  @ApiProperty()
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
  @IsBoolean()
  includeDevices?: boolean;
}
