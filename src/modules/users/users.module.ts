import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService, TenantsService } from '@modules/index.service';
import { User } from './entities/user.entity';
import { MailModule } from '../../modules/mail/mail.module';
import { AuditModule } from '../index.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from '@/common/interceptors/index.interceptor';
import { Tenant } from '@modules/index.entities';

@Module({
  imports: [TypeOrmModule.forFeature([User, Tenant]), MailModule],
  controllers: [UsersController],
  providers: [UsersService, TenantsService],
  exports: [UsersService],
})
export class UsersModule {}
