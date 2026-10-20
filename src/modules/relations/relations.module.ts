// src/modules/relations/relations.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EntityRelation } from './entities/entity-relation.entity';
import { RelationsService } from './relations.service';
import { RelationsController } from './relations.controller';

/**
 * Deliberately dependency-free.
 *
 * `RelationsService` reaches eight tables, but it does so through
 * `repository.manager.query()` against a constant table map — not by injecting
 * eight repositories and not by importing eight modules. Importing
 * `DevicesModule`, `AssetsModule`, `AlarmsModule`, `DashboardsModule`,
 * `UsersModule`, `CustomersModule`, `TenantsModule` and `EdgeModule` from one
 * leaf module would close several module-load cycles at once — the §4l trap,
 * which surfaces as a TDZ error at import time and a container crash-loop,
 * not as a compile error.
 *
 * It also makes this module safe to import from any of those eight later, so a
 * device delete can sweep its relations without anything becoming circular.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EntityRelation])],
  controllers: [RelationsController],
  providers: [RelationsService],
  exports: [RelationsService],
})
export class RelationsModule {}
