import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { File as MulterFile } from 'multer';
import { Image } from './entities/image.entity';
import { CreateImageDto } from './dto/create-image.dto';
import { UpdateImageDto } from './dto/update-image.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '../../common/dto/pagination.dto';

/** Upload ceiling. Mirrored by the FileInterceptor so multer rejects early. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * MIME type → on-disk extension. Doubling as the allowlist means the stored
 * filename's extension is derived from the validated MIME type, so nothing the
 * client controls ever reaches the filesystem path.
 */
export const ALLOWED_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

@Injectable()
export class ImagesService implements OnModuleInit {
  private readonly logger = new Logger(ImagesService.name);

  /** Disk location. Public URLs are always rooted at `/uploads/images`. */
  private readonly imageDir =
    process.env.UPLOAD_PATH_IMAGES || './uploads/images';
  private readonly publicPrefix = '/uploads/images';

  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await fs.mkdir(this.imageDir, { recursive: true });
      this.logger.log(`Image upload directory ready: ${this.imageDir}`);
    } catch (error) {
      this.logger.error('Failed to create image upload directory', error);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    createImageDto: CreateImageDto,
    file: MulterFile,
    userId: string,
    tenantId: string,
    customerId?: string | null,
  ): Promise<Image> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Re-checked here (the FileInterceptor already filters) so the service is
    // safe to call from anywhere, not just that one route.
    const ext = ALLOWED_IMAGE_MIME_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException(
        `File type '${file.mimetype}' is not allowed. ` +
          `Allowed: ${[...new Set(Object.values(ALLOWED_IMAGE_MIME_TYPES))].join(', ')}`,
      );
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `File too large. Maximum size is ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`,
      );
    }

    if (!file.buffer?.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    await fs.mkdir(this.imageDir, { recursive: true });

    const fileName = `${randomUUID()}.${ext}`;
    const diskPath = path.join(this.imageDir, fileName);
    await fs.writeFile(diskPath, file.buffer);

    const image = this.imageRepository.create({
      // Client metadata first — every server-derived field below must win.
      ...createImageDto,
      name: createImageDto.name || file.originalname,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `${this.publicPrefix}/${fileName}`,
      path: this.toStoredPath(diskPath),
      storageProvider: 'local',
      tenantId,
      userId,
      uploadedBy: userId,
      createdBy: userId,
      ...(customerId ? { customerId } : {}),
    });

    try {
      const saved = await this.imageRepository.save(image);
      this.logger.log(
        `Image uploaded: ${saved.id} (${fileName}) by user ${userId}`,
      );
      return saved;
    } catch (error) {
      // Do not leave the bytes behind if the row never landed.
      await fs.unlink(diskPath).catch(() => undefined);
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;

    const queryBuilder = this.imageRepository
      .createQueryBuilder('image')
      .where('image.tenantId = :tenantId', { tenantId });

    if (search) {
      queryBuilder.andWhere(
        '(image.name ILIKE :search OR image.originalName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`image.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, tenantId: string): Promise<Image> {
    const image = await this.imageRepository.findOne({
      where: { id, tenantId },
    });

    if (!image) {
      throw new NotFoundException('Image not found');
    }

    return image;
  }

  /**
   * Resolves an image row to a readable file on disk. Also bumps the download
   * counter the entity already tracks.
   */
  async getImageFile(
    id: string,
    tenantId: string,
  ): Promise<{ path: string; contentType: string; fileName: string }> {
    const image = await this.findOne(id, tenantId);

    const absolutePath = this.resolveStoredPath(image.path);
    if (!absolutePath) {
      throw new NotFoundException('Image file not found');
    }

    try {
      await fs.access(absolutePath);
    } catch {
      throw new NotFoundException('Image file is missing from disk');
    }

    await this.imageRepository.increment({ id: image.id }, 'downloadCount', 1);

    return {
      path: absolutePath,
      contentType: image.mimeType || 'application/octet-stream',
      // Header-injection guard: originalName is whatever the client typed.
      fileName: this.sanitiseFileName(
        image.originalName || path.basename(absolutePath),
      ),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  /** Metadata only — the stored bytes are immutable; re-upload to replace. */
  async update(
    id: string,
    tenantId: string,
    userId: string,
    updateImageDto: UpdateImageDto,
  ): Promise<Image> {
    const image = await this.findOne(id, tenantId);

    Object.assign(image, updateImageDto);
    image.updatedBy = userId;

    const saved = await this.imageRepository.save(image);
    this.logger.log(`Image updated: ${id} by user ${userId}`);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  async remove(id: string, tenantId: string, userId: string): Promise<void> {
    const image = await this.findOne(id, tenantId);

    const absolutePath = this.resolveStoredPath(image.path);
    if (absolutePath) {
      await fs.unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
        // Already gone is not worth failing the request over — the row still
        // has to be soft-deleted.
        this.logger.warn(
          `Failed to delete image file ${image.path}: ${error.message}`,
        );
      });
    }

    // softRemove only writes deleted_at, so deletedBy needs its own statement.
    await this.imageRepository.update({ id: image.id }, { deletedBy: userId });
    await this.imageRepository.softRemove(image);
    this.logger.log(`Image deleted: ${id} by user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  async getStatistics(tenantId: string) {
    const total = await this.imageRepository.count({ where: { tenantId } });

    const sizeResult = await this.imageRepository
      .createQueryBuilder('image')
      .select('SUM(image.size)', 'totalSize')
      .where('image.tenantId = :tenantId', { tenantId })
      .getRawOne();

    const typeResult = await this.imageRepository
      .createQueryBuilder('image')
      .select('image.mimeType', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('image.tenantId = :tenantId', { tenantId })
      .groupBy('image.mimeType')
      .getRawMany();

    const byType = typeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total,
      totalSize: parseInt(sizeResult?.totalSize || '0', 10),
      byType,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PATH HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** Store cwd-relative, forward-slashed, so rows survive a host/OS change. */
  private toStoredPath(diskPath: string): string {
    return path
      .relative(process.cwd(), path.resolve(diskPath))
      .split(path.sep)
      .join('/');
  }

  /**
   * Turns a stored path back into an absolute one, refusing anything that
   * escapes the image directory. Rows written before this fix hold the literal
   * `/uploads/images/undefined`; they resolve outside the directory and come
   * back as `null` rather than pointing `unlink()` at a stray path.
   */
  private resolveStoredPath(storedPath?: string | null): string | null {
    if (!storedPath) return null;

    const root = path.resolve(this.imageDir);
    const absolute = path.resolve(process.cwd(), storedPath);
    const relative = path.relative(root, absolute);

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return absolute;
  }

  private sanitiseFileName(fileName: string): string {
    return path.basename(fileName).replace(/["\r\n]/g, '') || 'image';
  }
}
