import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { ImagesService } from './images.service';
import { CreateImageDto } from './dto/create-image.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('images')
@Controller('images')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a new image' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    // TODO: Handle actual file upload to storage (S3, local, etc.)
    const createImageDto: CreateImageDto = {
      name: body.name || file.originalname,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `/uploads/images/${file.filename}`,
      path: `/uploads/images/${file.filename}`,
    };

    return this.imagesService.create(user.id, createImageDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all images' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.imagesService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get image statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.imagesService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get image by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.imagesService.findOne(id, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete image' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.imagesService.remove(id, user.id);
  }
}
