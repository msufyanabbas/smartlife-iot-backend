// src/modules/attributes/controllers/attributes.controller.ts
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
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { AttributeScope } from '@common/enums/index.enum';

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
    return this.attributesService.create(user, createDto);
  }

  @Post(':entityType/:entityId/:scope')
  @ApiOperation({ summary: 'Save multiple attributes for an entity' })
  @ApiResponse({ status: 201, description: 'Attributes saved successfully' })
  async saveAttributes(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('scope') scope: AttributeScope,
    @Body() body: SaveAttributesDto,
  ) {
    const attributes = await this.attributesService.saveAttributes(
      user,
      entityType,
      entityId,
      scope,
      body.attributes,
    );

    return {
      message: 'Attributes saved successfully',
      data: attributes,
    };
  }

  @Get(':entityType/:entityId')
  @ApiOperation({ summary: 'Get all attributes for an entity' })
  @ApiResponse({ status: 200, description: 'Entity attributes' })
  async findByEntity(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    const attributes = await this.attributesService.findByEntity(
      user.tenantId,
      entityType,
      entityId,
      scope,
    );

    return {
      message: 'Attributes retrieved successfully',
      data: attributes,
    };
  }

  @Get(':entityType/:entityId/keys')
  @ApiOperation({ summary: 'Get specific attribute keys for an entity' })
  @ApiResponse({ status: 200, description: 'Attribute values' })
  async findByKeys(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    const attributes = await this.attributesService.findByKeys(
      user.tenantId,
      entityType,
      entityId,
      keyArray,
      scope,
    );

    return {
      message: 'Attributes retrieved successfully',
      data: attributes,
    };
  }

  @Get(':entityType/:entityId/timeseries')
  @ApiOperation({ summary: 'Get timeseries data for entity' })
  @ApiResponse({ status: 200, description: 'Timeseries data' })
  async getTimeseries(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('startTs') startTs?: number,
    @Query('endTs') endTs?: number,
    @Query('limit') limit?: number,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    const timeseries = await this.attributesService.getTimeseries(
      user.tenantId,
      entityType,
      entityId,
      keyArray,
      startTs,
      endTs,
      limit,
    );

    return {
      message: 'Timeseries data retrieved successfully',
      data: timeseries,
    };
  }

  @Get(':entityType/:entityId/latest')
  @ApiOperation({ summary: 'Get latest values for specific keys' })
  @ApiResponse({ status: 200, description: 'Latest attribute values' })
  async getLatestValues(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    const latest = await this.attributesService.getLatestValues(
      user.tenantId,
      entityType,
      entityId,
      keyArray,
    );

    return {
      message: 'Latest values retrieved successfully',
      data: latest,
    };
  }

  @Delete(':entityType/:entityId/:attributeKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an attribute' })
  @ApiResponse({ status: 204, description: 'Attribute deleted' })
  deleteAttribute(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('attributeKey') attributeKey: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    return this.attributesService.deleteAttribute(
      user.tenantId,
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
  async deleteAttributes(
    @CurrentUser() user: User,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('keys') keys: string,
    @Query('scope') scope?: AttributeScope,
  ) {
    const keyArray = keys.split(',').map((k) => k.trim());
    const count = await this.attributesService.deleteAttributes(
      user.tenantId,
      entityType,
      entityId,
      keyArray,
      scope,
    );

    return {
      message: `${count} attributes deleted successfully`,
      deleted: count,
    };
  }
}