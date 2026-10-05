import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Public } from '@common/decorators/public.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiResponse, ApiConsumes, ApiBody, ApiOperation } from '@nestjs/swagger';
import type { File as MulterFile } from 'multer';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import {
  ImagesService,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
} from './images.service';
import { CreateImageDto } from './dto/create-image.dto';
import { UpdateImageDto } from './dto/update-image.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { PaginationDto } from '@common/dto/pagination.dto';

// Rejected here as well as in the service so multer stops reading the stream
// as soon as the part header shows an unsupported type.
const imageFileFilter = (
  _req: unknown,
  file: MulterFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void => {
  if (ALLOWED_IMAGE_MIME_TYPES[file.mimetype]) {
    callback(null, true);
    return;
  }
  callback(
    new BadRequestException(
      `File type '${file.mimetype}' is not allowed. ` +
        `Allowed: ${[...new Set(Object.values(ALLOWED_IMAGE_MIME_TYPES))].join(', ')}`,
    ),
    false,
  );
};

@ApiTags('Images')
@Controller('images')
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  @Post()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Upload a new image', 'Image uploaded')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
        description: { type: 'string' },
        alt: { type: 'string' },
        title: { type: 'string' },
        entityType: { type: 'string' },
        entityId: { type: 'string', format: 'uuid' },
        fieldName: { type: 'string' },
        isPublic: { type: 'boolean' },
        tags: { type: 'string', description: 'Comma-separated' },
        dimensions: {
          type: 'string',
          description: 'JSON, e.g. {"width":1920,"height":1080}',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'No file, unsupported type, or invalid metadata',
  })
  @ApiResponse({ status: 413, description: 'File exceeds the size limit' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMAGE_BYTES },
      fileFilter: imageFileFilter,
    }),
  )
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @UploadedFile() file: MulterFile,
    @Body() createImageDto: CreateImageDto,
  ) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }
    return this.imagesService.create(
      createImageDto,
      file,
      userId,
      tenantId,
      customerId,
    );
  }

  @Get()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all images', 'List of images')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.imagesService.findAll(tenantId, paginationDto);
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get image statistics')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.imagesService.getStatistics(tenantId);
  }

  // Public, unauthenticated. Declared BEFORE the ':id' routes below, or Nest
  // matches 'public' as an id and this never runs.
  @Get('public/:id')
  @Public()
  @ApiOperation({
    summary: 'Serve a public image without authentication',
    description:
      'Only images explicitly marked public are reachable here. Used for embedding ' +
      'images in dashboards and widget descriptors by reference, so they render for ' +
      'any dashboard viewer. Returns 404 for both missing and non-public images, so ' +
      'ids cannot be probed.',
  })
  @ApiResponse({ status: 404, description: 'Image not found or not public' })
  async servePublic(@Param('id', ParseIdPipe) id: string, @Res() res: Response) {
    const { path: filePath, contentType, fileName } =
      await this.imagesService.getPublicImageFile(id);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Public images are content-addressed by id and never mutate in place, so a
    // long cache is safe and keeps dashboards off the origin on every render.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    createReadStream(filePath).pipe(res);
  }

  @Post('resolve')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Resolve image references to URLs in one call',
    description:
      'Dashboards store image references rather than URLs. Resolving twenty of them ' +
      'one at a time is twenty round trips; this does it in one. Unknown ids resolve ' +
      'to null rather than erroring, so one stale reference cannot blank a dashboard.',
  })
  resolveReferences(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: { ids: string[] },
  ) {
    return this.imagesService.resolveReferences(body?.ids ?? [], tenantId);
  }

  @Patch(':id/public')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Mark an image public or private' })
  setPublic(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: { isPublic: boolean },
  ) {
    return this.imagesService.setPublic(id, tenantId, body?.isPublic === true);
  }

  @Get(':id/download')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Stream the stored image file', 'Image stream')
  @ApiResponse({ status: 404, description: 'Image or file not found' })
  async download(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const { path: filePath, contentType, fileName } =
      await this.imagesService.getImageFile(id, tenantId);

    // @Res() bypasses the global TransformInterceptor so raw bytes are sent.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    // An uploaded SVG is an active document; deny it any capability of its own.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    createReadStream(filePath).pipe(res);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get image by ID')
  @ApiResponse({ status: 404, description: 'Image not found' })
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.imagesService.findOne(id, tenantId);
  }

  @Patch(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update image metadata', 'Image updated')
  @ApiResponse({ status: 404, description: 'Image not found' })
  update(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateImageDto: UpdateImageDto,
  ) {
    return this.imagesService.update(id, tenantId, userId, updateImageDto);
  }

  @Delete(':id')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @SwaggerAuth('Delete image')
  @ApiResponse({ status: 404, description: 'Image not found' })
  remove(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.imagesService.remove(id, tenantId, userId);
  }
}
