import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SolutionTemplatesService } from './solution-template.service';
import { SolutionTemplatesController } from './solution-templates.controller';
import { SolutionTemplate } from './entities/solution-template.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SolutionTemplate])],
  controllers: [SolutionTemplatesController],
  providers: [SolutionTemplatesService],
  exports: [SolutionTemplatesService],
})
export class SolutionTemplatesModule {}
