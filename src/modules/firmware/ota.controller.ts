import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { FirmwareService } from './firmware.service';
import { OtaStatusDto } from './dto/ota-status.dto';
import { Public } from '@common/decorators/public.decorator';

/**
 * Device-facing OTA endpoints — authenticated by the device token (deviceKey)
 * in the path, NOT by JWT, hence @Public(). Devices are dumb clients: the
 * global TransformInterceptor still wraps JSON responses as { success, data },
 * except /download which streams raw octet-stream via @Res().
 */
@ApiTags('ota')
@Controller('ota')
export class OtaController {
  constructor(private readonly firmwareService: FirmwareService) {}

  @Get(':deviceToken')
  @Public()
  @ApiOperation({ summary: 'Device polls for a pending firmware update' })
  check(@Param('deviceToken') deviceToken: string) {
    return this.firmwareService.checkForDevice(deviceToken);
  }

  @Get(':deviceToken/download')
  @Public()
  @ApiOperation({ summary: 'Device downloads the pending firmware binary' })
  async download(
    @Param('deviceToken') deviceToken: string,
    @Res() res: Response,
  ): Promise<void> {
    const { firmware, absolutePath } =
      await this.firmwareService.getPendingFirmwareFile(deviceToken);

    res.set({
      'Content-Type': firmware.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${firmware.fileName}"`,
      'Content-Length': String(firmware.size),
      'X-Firmware-Checksum': firmware.checksum,
      'X-Firmware-Version': firmware.version,
    });

    createReadStream(absolutePath).pipe(res);
  }

  @Post(':deviceToken/status')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Device reports OTA progress/result' })
  reportStatus(
    @Param('deviceToken') deviceToken: string,
    @Body() dto: OtaStatusDto,
  ) {
    return this.firmwareService.reportStatus(deviceToken, dto);
  }
}
