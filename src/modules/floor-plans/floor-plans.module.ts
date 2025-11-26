import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FloorPlansService } from './floor-plans.service';
import { FloorPlansController } from './floor-plans.controller';
import { FloorPlan } from './entities/floor-plan.entity';

@Module({
  imports: [TypeOrmModule.forFeature([FloorPlan])],
  controllers: [FloorPlansController],
  providers: [FloorPlansService],
  exports: [FloorPlansService],
})
export class FloorPlansModule {}
