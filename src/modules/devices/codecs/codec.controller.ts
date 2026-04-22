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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
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