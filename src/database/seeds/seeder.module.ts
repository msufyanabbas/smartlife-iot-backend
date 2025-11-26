import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseSeederService } from './database-seeder.service';
import { SEEDERS } from './index.seeder';

const entities = SEEDERS.map((config) => config.entity).filter(Boolean);
@Module({
  imports: [TypeOrmModule.forFeature(entities)],
  providers: [
    DatabaseSeederService,
    // Dynamically register all seeders from index.seeder.ts
    ...SEEDERS.map((config) => config.seeder),
  ],
  exports: [DatabaseSeederService],
})
export class SeederModule {}
