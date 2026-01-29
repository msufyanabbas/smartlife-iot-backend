// src/modules/devices/codecs/codec.controller.ts
/**
 * Codec Management API
 * Allows admins to view and test codecs
 */

import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
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
  constructor(private codecRegistry: CodecRegistryService) {}

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all registered codecs' })
  @ApiResponse({ status: 200, description: 'Codecs retrieved' })
  listCodecs() {
    const codecs = this.codecRegistry.listCodecs();
    return {
      message: 'Codecs retrieved successfully',
      data: codecs,
      total: codecs.length,
    };
  }

  @Post('test-decode')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test decode a payload' })
  @ApiResponse({ status: 200, description: 'Payload decoded' })
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

    return {
      message: 'Payload decoded successfully',
      data: decoded,
    };
  }

  @Post('test-encode')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test encode a command' })
  @ApiResponse({ status: 200, description: 'Command encoded' })
  testEncode(
    @Body()
    body: {
      codecId: string;
      command: {
        type: string;
        params?: any;
      };
    },
  ) {
    const encoded = this.codecRegistry.encode(body.command, {
      codecId: body.codecId,
    });

    return {
      message: 'Command encoded successfully',
      data: encoded,
    };
  }

  @Post('auto-detect')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-detect codec for payload' })
  @ApiResponse({ status: 200, description: 'Codec detected' })
  autoDetect(
    @Body()
    body: {
      payload: string;
      fPort?: number;
    },
  ) {
    const codec = this.codecRegistry.detectCodec(body.payload, {
      fPort: body.fPort,
    });

    if (!codec) {
      return {
        message: 'No codec detected',
        data: null,
      };
    }

    return {
      message: 'Codec detected',
      data: {
        codecId: codec.codecId,
        manufacturer: codec.manufacturer,
        supportedModels: codec.supportedModels,
        protocol: codec.protocol,
      },
    };
  }
}