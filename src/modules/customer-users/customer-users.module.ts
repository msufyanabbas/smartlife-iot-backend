import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerUsersController } from './customer-users.controller';
import { CustomerUsersService } from './customer-users.service';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { Tenant } from '../index.entities';
import { CustomersService, MailService, TenantsService } from '../index.service';
import { MailModule, TenantsModule } from '../index.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant]),
    CustomersModule,
    UsersModule,
    MailModule,
    TenantsModule,
    MailModule
  ],
  controllers: [CustomerUsersController],
  providers: [CustomerUsersService],
  exports: [CustomerUsersService],
})
export class CustomerUsersModule {}