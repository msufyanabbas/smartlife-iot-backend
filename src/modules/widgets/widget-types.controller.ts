// src/modules/widgets/widget-types.controller.ts
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { WidgetTypesService } from './widget-types.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';

/**
 * The widget catalogue, as the dashboard editor needs it.
 *
 * Distinct from WidgetsController (`/widgets/types/...`), which is the
 * admin-facing CRUD surface. This one is read-only, tenant-scoped, and shaped
 * for the "pick a widget" step: grouped by bundle in one round-trip.
 */
@ApiTags('Widget Types')
@Controller('widget-types')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WidgetTypesController {
  constructor(private readonly widgetTypesService: WidgetTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List widget types grouped by bundle' })
  @ApiResponse({ status: 200, description: 'Bundles with their widget types' })
  findAllGrouped(@CurrentUser('tenantId') tenantId?: string) {
    return this.widgetTypesService.findGroupedByBundle(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single widget type with its full descriptor' })
  @ApiResponse({ status: 200, description: 'Widget type' })
  @ApiResponse({ status: 404, description: 'Widget type not found' })
  findOne(@Param('id', ParseIdPipe) id: string) {
    return this.widgetTypesService.findOne(id);
  }
}
