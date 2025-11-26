import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Share, ShareType } from './entities/sharing.entity';
import { CreateShareDto } from './dto/create-sharing.dto';
import { UpdateShareDto } from './dto/update-sharing.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class SharingService {
  constructor(
    @InjectRepository(Share)
    private readonly shareRepository: Repository<Share>,
  ) {}

  async create(userId: string, createShareDto: CreateShareDto): Promise<Share> {
    // Validate share type and required fields
    if (
      createShareDto.shareType === ShareType.EMAIL &&
      !createShareDto.sharedWith
    ) {
      throw new BadRequestException(
        'Email address is required for email shares',
      );
    }

    const share = this.shareRepository.create({
      ...createShareDto,
      userId,
      sharedBy: userId,
      createdBy: userId,
      token:
        createShareDto.shareType === ShareType.LINK
          ? this.generateToken()
          : undefined,
    });

    return await this.shareRepository.save(share);
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

    const queryBuilder = this.shareRepository
      .createQueryBuilder('share')
      .where('share.sharedBy = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(share.sharedWith ILIKE :search OR share.metadata::text ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`share.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string, userId: string): Promise<Share> {
    const share = await this.shareRepository.findOne({
      where: { id, sharedBy: userId },
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    return share;
  }

  async findByToken(token: string): Promise<Share> {
    const share = await this.shareRepository.findOne({
      where: { token },
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    // Check if share has expired
    if (share.expiresAt && new Date() > share.expiresAt) {
      throw new ForbiddenException('This share link has expired');
    }

    return share;
  }

  async update(
    id: string,
    userId: string,
    updateShareDto: UpdateShareDto,
  ): Promise<Share> {
    const share = await this.findOne(id, userId);

    Object.assign(share, updateShareDto);
    share.updatedBy = userId;

    return await this.shareRepository.save(share);
  }

  async remove(id: string, userId: string): Promise<void> {
    const share = await this.findOne(id, userId);
    await this.shareRepository.softRemove(share);
  }

  async trackView(token: string): Promise<Share> {
    const share = await this.findByToken(token);

    share.views += 1;
    await this.shareRepository.save(share);

    return share;
  }

  async getStatistics(userId: string) {
    const [total, activeShares, emailShares, linkShares] = await Promise.all([
      this.shareRepository.count({ where: { sharedBy: userId } }),
      this.shareRepository.count({
        where: {
          sharedBy: userId,
          expiresAt: MoreThan(new Date()),
        },
      }),
      this.shareRepository.count({
        where: { sharedBy: userId, shareType: ShareType.EMAIL },
      }),
      this.shareRepository.count({
        where: { sharedBy: userId, shareType: ShareType.LINK },
      }),
    ]);

    const byResourceTypeResult = await this.shareRepository
      .createQueryBuilder('share')
      .select('share.resourceType', 'resourceType')
      .addSelect('COUNT(*)', 'count')
      .where('share.sharedBy = :userId', { userId })
      .groupBy('share.resourceType')
      .getRawMany();

    const byResourceType = byResourceTypeResult.reduce(
      (acc, item) => {
        acc[item.resourceType] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const totalViewsResult = await this.shareRepository
      .createQueryBuilder('share')
      .select('SUM(share.views)', 'total')
      .where('share.sharedBy = :userId', { userId })
      .getRawOne();

    return {
      total,
      active: activeShares,
      expired: total - activeShares,
      emailShares,
      linkShares,
      byResourceType,
      totalViews: parseInt(totalViewsResult?.total || '0'),
    };
  }

  async getSharedWithMe(
    userId: string,
    userEmail: string,
    paginationDto: PaginationDto,
  ) {
    const { page = 1, limit = 10 } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.shareRepository
      .createQueryBuilder('share')
      .where('share.sharedWith = :userEmail', { userEmail })
      .andWhere('(share.expiresAt IS NULL OR share.expiresAt > :now)', {
        now: new Date(),
      })
      .orderBy('share.createdAt', 'DESC')
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

  async revokeByResourceId(
    userId: string,
    resourceId: string,
  ): Promise<number> {
    const result = await this.shareRepository.softDelete({
      sharedBy: userId,
      resourceId,
    });

    return result.affected || 0;
  }

  private generateToken(): string {
    return uuidv4().replace(/-/g, '');
  }
}
