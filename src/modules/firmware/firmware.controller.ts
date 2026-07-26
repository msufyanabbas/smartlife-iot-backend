import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { File as MulterFile } from 'multer';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { FirmwareService } from './firmware.service';
import { CreateFirmwareDto } from './dto/create-firmware.dto';
import { AssignFirmwareDto } from './dto/assign-firmware.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { PaginationDto } from '@common/dto/pagination.dto';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';

@ApiTags('firmware')
@Controller('firmware')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FirmwareController {
  constructor(private readonly firmwareService: FirmwareService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a new firmware package' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: User,
    @UploadedFile() file: MulterFile,
    @Body() dto: CreateFirmwareDto,
  ) {
    return this.firmwareService.create(
      user.id,
      user.tenantId,
      user.customerId ?? null,
      dto,
      file,
    );
  }

  @Post(':id/assign')
  @ApiOperation({
    summary: 'Assign a firmware version to a device or device profile',
  })
  assign(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AssignFirmwareDto,
  ) {
    return this.firmwareService.assign(id, user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List firmware packages' })
  findAll(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.firmwareService.findAll(user.tenantId, pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get firmware package by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.firmwareService.findOne(id, user.tenantId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a firmware package' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.firmwareService.remove(id, user.tenantId);
  }
}
