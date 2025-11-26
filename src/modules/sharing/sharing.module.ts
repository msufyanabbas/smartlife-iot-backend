import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharingService } from './sharing.service';
import { SharingController } from './sharing.controller';
import { Share } from './entities/sharing.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Share])],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
