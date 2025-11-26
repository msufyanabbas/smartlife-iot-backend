import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EdgeService } from './edge.service';
import { EdgeController } from './edge.controller';
import { EdgeInstance } from './entities/edge-instance.entity';

@Module({
  imports: [TypeOrmModule.forFeature([EdgeInstance])],
  controllers: [EdgeController],
  providers: [EdgeService],
  exports: [EdgeService],
})
export class EdgeModule {}
