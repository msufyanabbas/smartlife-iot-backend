import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { Role } from './entities/roles.entity';
import { Permission } from '@/modules/permissions/entities/permissions.entity';
import { Tenant } from '@/modules/tenants/entities/tenant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Role, Permission, Tenant])
  ],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService]
})
export class RolesModule {}