import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Image } from './entities/image.entity';
import { CreateImageDto } from './dto/create-image.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class ImagesService {
  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
  ) {}

  async create(userId: string, createImageDto: CreateImageDto): Promise<Image> {
    const image = this.imageRepository.create({
      ...createImageDto,
      userId,
      uploadedBy: userId,
      createdBy: userId,
    });

    return await this.imageRepository.save(image);
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.imageRepository
      .createQueryBuilder('image')
      .where('image.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(image.name ILIKE :search OR image.originalName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`image.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, userId: string): Promise<Image> {
    const image = await this.imageRepository.findOne({
      where: { id, userId },
    });

    if (!image) {
      throw new NotFoundException('Image not found');
    }

    return image;
  }

  async remove(id: string, userId: string): Promise<void> {
    const image = await this.findOne(id, userId);
    // TODO: Delete actual file from storage
    await this.imageRepository.softRemove(image);
  }

  async getStatistics(userId: string) {
    const [total] = await Promise.all([
      this.imageRepository.count({ where: { userId } }),
    ]);

    const sizeResult = await this.imageRepository
      .createQueryBuilder('image')
      .select('SUM(image.size)', 'totalSize')
      .where('image.userId = :userId', { userId })
      .getRawOne();

    const typeResult = await this.imageRepository
      .createQueryBuilder('image')
      .select('image.mimeType', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('image.userId = :userId', { userId })
      .groupBy('image.mimeType')
      .getRawMany();

    const byType = typeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total,
      totalSize: parseInt(sizeResult?.totalSize || '0'),
      byType,
    };
  }
}
