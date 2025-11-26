import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EdgeInstance, EdgeStatus } from './entities/edge-instance.entity';
import { CreateEdgeInstanceDto } from './dto/create-edge-instance.dto';
import { UpdateEdgeInstanceDto } from './dto/update-edge-instance.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class EdgeService {
  constructor(
    @InjectRepository(EdgeInstance)
    private readonly edgeRepository: Repository<EdgeInstance>,
  ) {}

  async create(
    userId: string,
    createDto: CreateEdgeInstanceDto,
  ): Promise<EdgeInstance> {
    const edge = this.edgeRepository.create({
      ...createDto,
      userId,
      createdBy: userId,
      dataSync: { pending: 0 },
    });
    return await this.edgeRepository.save(edge);
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const { page = 1, limit = 10 } = paginationDto;
    const [data, total] = await this.edgeRepository.findAndCount({
      where: { userId },
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string, userId: string): Promise<EdgeInstance> {
    const edge = await this.edgeRepository.findOne({ where: { id, userId } });
    if (!edge) throw new NotFoundException('Edge instance not found');
    return edge;
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateEdgeInstanceDto,
  ): Promise<EdgeInstance> {
    const edge = await this.findOne(id, userId);
    Object.assign(edge, updateDto);
    edge.updatedBy = userId;
    return await this.edgeRepository.save(edge);
  }

  async remove(id: string, userId: string): Promise<void> {
    const edge = await this.findOne(id, userId);
    await this.edgeRepository.softRemove(edge);
  }

  async getStatistics(userId: string) {
    const [total, online] = await Promise.all([
      this.edgeRepository.count({ where: { userId } }),
      this.edgeRepository.count({
        where: { userId, status: EdgeStatus.ONLINE },
      }),
    ]);
    return { total, online, offline: total - online };
  }
}
