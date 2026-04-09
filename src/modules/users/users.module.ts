import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { MailModule } from '../mail/mail.module';
import { TenantsModule } from '../tenants/tenants.module';
import { NotificationsModule } from '../index.module';
import { Role } from '../roles/entities/roles.entity';
import { Permission } from '../permissions/entities/permissions.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant, Role, Permission]),
    MailModule,
    TenantsModule,
    forwardRef(() => NotificationsModule),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}