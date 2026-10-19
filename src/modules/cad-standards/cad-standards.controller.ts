import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CadStandardsService } from './cad-standards.service';
import { Public } from '@common/decorators/public.decorator';
import { TenantOrCustomerAdmin } from '@common/decorators/access-control.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';

class LayerInputDto {
  @IsString() name: string;
  @IsOptional() @IsNumber() @Min(0) entityCount?: number;
  @IsOptional() @IsString() linetype?: string;
}

class ValidateDrawingDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LayerInputDto)
  layers: LayerInputDto[];

  @IsOptional() @IsArray() @IsString({ each: true }) blocks?: string[];
  @IsOptional() @IsString() units?: string;
}

class CheckStairDto {
  @IsNumber() riserMm: number;
  @IsNumber() goingMm: number;
  @IsOptional() @IsNumber() widthMm?: number;
  @IsOptional() @IsNumber() flightRiseMm?: number;
}

/**
 * The CAD standard as an API.
 *
 * `GET /cad-standards` is @Public for the same reason the integration and
 * rule-node catalogues are: it contains no tenant data. It is a published
 * drawing convention — the same document a draughtsman would be handed — and
 * the frontend legend, the upload screen and the importer all read it.
 */
@ApiTags('CAD standards')
@Controller('cad-standards')
@ApiBearerAuth()
export class CadStandardsController {
  constructor(private readonly standards: CadStandardsService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'The drawing standard',
    description:
      'Layer rules, symbol legend, dimensional rules, line weights, ' +
      'linetypes and practice rules. Public: it is a published convention, ' +
      'not tenant data.',
  })
  getStandard() {
    return this.standards.getStandard();
  }

  @Get('classify')
  @Public()
  @ApiOperation({
    summary: 'Classify one layer name',
    description: 'What the layer is, and whether it becomes geometry.',
  })
  @ApiQuery({ name: 'layer', required: true, type: String })
  @ApiQuery({ name: 'linetype', required: false, type: String })
  classify(@Query('layer') layer: string, @Query('linetype') linetype?: string) {
    return this.standards.classify(layer, linetype);
  }

  @Post('validate')
  @TenantOrCustomerAdmin()
  @RequirePermissions('floor_plans:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a drawing against the standard',
    description:
      'Reports what will be built, what will be cut as an opening, what ' +
      'will be ignored and why, plus the layers the standard does not ' +
      'describe. Run this BEFORE generating a model — importing is lossy ' +
      'and the failure mode is otherwise silent.',
  })
  @ApiResponse({ status: 200, description: 'Compliance report' })
  validate(@Body() dto: ValidateDrawingDto) {
    return this.standards.validate(dto);
  }

  @Post('check-stair')
  @TenantOrCustomerAdmin()
  @RequirePermissions('floor_plans:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a stair against the design rules',
    description:
      'Riser, going, 2R+G, pitch, width and rise per flight, against the ' +
      'IBC-derived values in the library. Advisory — confirm the local code.',
  })
  checkStair(@Body() dto: CheckStairDto) {
    return this.standards.checkStair(dto);
  }
}
