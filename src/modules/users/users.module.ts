import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';                          // ← direct
import { TenantsService } from '../tenants/tenants.service';            // ← direct
import { User } from './entities/user.entity';
import { Tenant } from '../tenants/entities/tenant.entity';             // ← direct
import { MailModule } from '../mail/mail.module';
import { TenantsModule } from '../tenants/tenants.module';              // ← import module

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant]),
    MailModule,
    TenantsModule,   // ← add this so TenantsService is properly provided
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    // TenantsService,  ← remove this, let TenantsModule provide it
  ],
  exports: [UsersService],
})
export class UsersModule {}