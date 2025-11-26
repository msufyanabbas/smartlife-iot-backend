import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Script } from './entities/script.entity';
import { CreateScriptDto } from './dto/create-script.dto';
import { UpdateScriptDto } from './dto/update-script.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class ScriptsService {
  constructor(
    @InjectRepository(Script)
    private readonly scriptRepository: Repository<Script>,
  ) {}

  async create(
    userId: string,
    createScriptDto: CreateScriptDto,
  ): Promise<Script> {
    const lines = createScriptDto.code.split('\n').length;

    const script = this.scriptRepository.create({
      ...createScriptDto,
      userId,
      createdBy: userId,
      lines,
      lastModified: new Date(),
    });

    return await this.scriptRepository.save(script);
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'lastModified',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.scriptRepository
      .createQueryBuilder('script')
      .where('script.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(script.name ILIKE :search OR script.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`script.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string, userId: string): Promise<Script> {
    const script = await this.scriptRepository.findOne({
      where: { id, userId },
    });

    if (!script) {
      throw new NotFoundException('Script not found');
    }

    return script;
  }

  async update(
    id: string,
    userId: string,
    updateScriptDto: UpdateScriptDto,
  ): Promise<Script> {
    const script = await this.findOne(id, userId);

    if (updateScriptDto.code) {
      updateScriptDto['lines'] = updateScriptDto.code.split('\n').length;
    }

    Object.assign(script, updateScriptDto);
    script.updatedBy = userId;
    script.lastModified = new Date();

    return await this.scriptRepository.save(script);
  }

  async remove(id: string, userId: string): Promise<void> {
    const script = await this.findOne(id, userId);
    await this.scriptRepository.softRemove(script);
  }

  async test(
    id: string,
    userId: string,
    testData: any,
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const script = await this.findOne(id, userId);

    try {
      // TODO: Implement actual script execution in a sandboxed environment
      // For now, return a mock result
      return {
        success: true,
        result: `Script "${script.name}" executed successfully with test data`,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async execute(id: string, userId: string, inputData: any): Promise<any> {
    const script = await this.findOne(id, userId);

    // TODO: Implement actual script execution
    return {
      scriptId: script.id,
      scriptName: script.name,
      executed: true,
      result: inputData,
    };
  }

  async getStatistics(userId: string) {
    const [total] = await Promise.all([
      this.scriptRepository.count({ where: { userId } }),
    ]);

    const byTypeResult = await this.scriptRepository
      .createQueryBuilder('script')
      .select('script.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('script.userId = :userId', { userId })
      .groupBy('script.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total,
      byType,
    };
  }
}
