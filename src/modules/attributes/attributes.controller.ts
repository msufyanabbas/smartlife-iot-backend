import {
  Controller,
  Get,
  Post,
  Body,
  Delete,
  UseGuards,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AttributesService } from './attributes.service';
import {
  CreateAttributeDto,
  SaveAttributesDto,
} from './dto/create-attribute.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { AttributeScope } from './entities/attribute.entity';

@ApiTags('attributes')
@Controller('attributes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AttributesController {
  constructor(private readonly attributesService: AttributesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a single attribute' })
  @ApiResponse({ status: 201, description: 'Attribute created successfully' })
  create(@CurrentUser() user: User, @Body() createDto: CreateAttributeDto) {
    return this.attributesService.create(user.id, createDto);
  }

  @Post(':entityType/:entityId/:scope')
  @ApiOperation({ summary: 'Save multiple attributes for an entity' })
  @ApiResponse({ status: 201, description: 'Attributes saved successfully' })
  saveAttributes(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('scope') scope: AttributeScope,
    @Body() body: SaveAttributesDto,
  ) {
    return this.attributesService.saveAttributes(
      user.id,
      entityType,
      entityId,
      scope,
      body.attributes,
    );
  }

  @Get(':entityType/:entityId')
  @ApiOperation({ summary: 'Get all attributes for an entity' })
  @ApiResponse({ status: 200, description: 'Entity attributes' })
  findByEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    return this.attributesService.findByEntity(entityType, entityId, scope);
  }

  @Get(':entityType/:entityId/keys')
  @ApiOperation({ summary: 'Get specific attribute keys for an entity' })
  @ApiResponse({ status: 200, description: 'Attribute values' })
  findByKeys(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    return this.attributesService.findByKeys(
      entityType,
      entityId,
      keyArray,
      scope,
    );
  }

  @Get(':entityType/:entityId/timeseries')
  @ApiOperation({ summary: 'Get timeseries data for entity' })
  @ApiResponse({ status: 200, description: 'Timeseries data' })
  getTimeseries(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('startTs') startTs?: number,
    @Query('endTs') endTs?: number,
    @Query('limit') limit?: number,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    return this.attributesService.getTimeseries(
      entityType,
      entityId,
      keyArray,
      startTs,
      endTs,
      limit,
    );
  }

  @Delete(':entityType/:entityId/:attributeKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an attribute' })
  @ApiResponse({ status: 204, description: 'Attribute deleted' })
  deleteAttribute(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('attributeKey') attributeKey: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    return this.attributesService.deleteAttribute(
      entityType,
      entityId,
      attributeKey,
      scope,
    );
  }

  @Delete(':entityType/:entityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete multiple attributes' })
  @ApiResponse({ status: 200, description: 'Attributes deleted' })
  deleteAttributes(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    return this.attributesService.deleteAttributes(
      entityType,
      entityId,
      keyArray,
      scope,
    );
  }
}
