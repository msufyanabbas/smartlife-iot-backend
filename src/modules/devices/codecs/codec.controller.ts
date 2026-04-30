// src/modules/devices/codecs/codec.controller.ts

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Roles } from '@/common/decorators/roles.decorator';
import { UserRole } from '@common/enums/index.enum';
import { CodecRegistryService } from './codec-registry.service';

@ApiTags('Codecs')
@Controller('codecs')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CodecController {
  constructor(private readonly codecRegistry: CodecRegistryService) {}

  // ── Catalog endpoints (called by the "Add Device" form) ───────────────────

  /**
   * GET /codecs/manufacturers
   *
   * Returns the sorted list of manufacturer names that have at least one
   * registered codec.  The frontend uses this to populate the first dropdown
   * when a user is creating a new device.
   *
   * Response shape:
   *   { data: ["Milesight", "Dragino", ...] }
   */
  @Get('manufacturers')
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
  @ApiOperation({ summary: 'List all manufacturers that have registered codecs' })
  @ApiResponse({ status: 200, description: 'Manufacturer list' })
  listManufacturers() {
    return {
      data: this.codecRegistry.listManufacturers(),
    };
  }

  /**
   * GET /codecs/manufacturers/:manufacturer/models
   *
   * Returns all models for the chosen manufacturer, each entry carrying the
   * codecId and protocol.  The frontend uses this to populate the second
   * dropdown and to auto-fill metadata.codecId before submitting.
   *
   * Response shape:
   *   {
   *     manufacturer: "Milesight",
   *     data: [
   *       { model: "WS558", codecId: "milesight-ws558", protocol: "lorawan" },
   *       { model: "WS558-868", codecId: "milesight-ws558", protocol: "lorawan" },
   *       { model: "EM300-TH", codecId: "milesight-em300", protocol: "lorawan" },
   *       ...
   *     ]
   *   }
   */
  @Get('manufacturers/:manufacturer/models')
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
  @ApiOperation({ summary: 'List models available for a manufacturer' })
  @ApiParam({ name: 'manufacturer', example: 'Milesight' })
  @ApiResponse({ status: 200, description: 'Model list for manufacturer' })
  listModelsForManufacturer(@Param('manufacturer') manufacturer: string) {
    return {
      manufacturer,
      data: this.codecRegistry.listModelsForManufacturer(manufacturer),
    };
  }

  /**
   * GET /codecs/catalog
   *
   * Full catalog grouped by manufacturer — useful for admin pages or
   * pre-fetching everything in one call.
   */
  @Get('catalog')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Full codec catalog grouped by manufacturer' })
  getCatalog() {
    return {
      data: this.codecRegistry.getCatalog(),
    };
  }


  /**
 * GET /codecs/manufacturers/:manufacturer/categories
 *
 * Returns distinct category names for a manufacturer.
 * Used to drive a "filter by category" chip/dropdown above the model picker.
 *
 * Response: { manufacturer: "Milesight", data: ["Ambience Monitoring", "Light Control", ...] }
 */
@Get('manufacturers/:manufacturer/categories')
@Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
@ApiOperation({ summary: 'List product categories available for a manufacturer' })
@ApiParam({ name: 'manufacturer', example: 'Milesight' })
listCategoriesForManufacturer(@Param('manufacturer') manufacturer: string) {
  return {
    manufacturer,
    data: this.codecRegistry.listCategoriesForManufacturer(manufacturer),
  };
}

/**
 * GET /codecs/manufacturers/:manufacturer/families
 * GET /codecs/manufacturers/:manufacturer/families?category=Ambience+Monitoring
 *
 * Returns model families (with variants) for a manufacturer.
 * Optionally filtered by category when the query param is provided.
 *
 * Response:
 *   {
 *     manufacturer: "Milesight",
 *     category: "Ambience Monitoring",   // echoed back if filtered
 *     data: [
 *       {
 *         family: "AM102",
 *         category: "Ambience Monitoring",
 *         variants: [
 *           { model: "AM102",   codecId: "milesight-am102", protocol: "lorawan" },
 *           { model: "AM102A",  codecId: "milesight-am102", protocol: "lorawan" },
 *           { model: "AM102-L", codecId: "milesight-am102", protocol: "lorawan" },
 *         ]
 *       },
 *       ...
 *     ]
 *   }
 */
@Get('manufacturers/:manufacturer/families')
@Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
@ApiOperation({ summary: 'List model families with variants, optionally filtered by category' })
@ApiParam({ name: 'manufacturer', example: 'Milesight' })
@ApiQuery({ name: 'category', required: false, example: 'Ambience Monitoring' })
listModelFamiliesForManufacturer(
  @Param('manufacturer') manufacturer: string,
  @Query('category') category?: string,
) {
  return {
    manufacturer,
    ...(category && { category }),
    data: this.codecRegistry.listModelFamiliesForManufacturer(manufacturer, category),
  };
}

/**
 * GET /codecs/catalog/v2
 *
 * Full structured catalog: manufacturer → categories → families → variants.
 * One call to prefetch everything for an "Add Device" wizard.
 */
@Get('catalog/v2')
@Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
@ApiOperation({ summary: 'Full structured catalog grouped by manufacturer, category, and model family' })
getStructuredCatalog() {
  return {
    data: this.codecRegistry.getStructuredCatalog(),
  };
}


  // ── Admin / debug endpoints ───────────────────────────────────────────────

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all registered codecs (raw)' })
  listCodecs() {
    const codecs = this.codecRegistry.listCodecs();
    return { data: codecs, total: codecs.length };
  }

  @Post('test-decode')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test-decode a payload' })
  testDecode(
    @Body()
    body: {
      payload: string;
      codecId?: string;
      manufacturer?: string;
      model?: string;
      fPort?: number;
    },
  ) {
    const decoded = this.codecRegistry.decode(body.payload, {
      codecId: body.codecId,
      manufacturer: body.manufacturer,
      model: body.model,
      fPort: body.fPort,
    });
    return { data: decoded };
  }

  @Post('test-encode')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test-encode a command' })
  testEncode(
    @Body()
    body: {
      codecId: string;
      command: { type: string; params?: any };
    },
  ) {
    const encoded = this.codecRegistry.encode(body.command, { codecId: body.codecId });
    return { data: encoded };
  }

  @Post('auto-detect')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-detect codec for a payload' })
  autoDetect(@Body() body: { payload: string; fPort?: number }) {
    const codec = this.codecRegistry.detectCodec(body.payload, { fPort: body.fPort });
    if (!codec) return { data: null, message: 'No codec detected' };
    return {
      data: {
        codecId: codec.codecId,
        manufacturer: codec.manufacturer,
        supportedModels: codec.supportedModels,
        protocol: codec.protocol,
      },
    };
  }
}