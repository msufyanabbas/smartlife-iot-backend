import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerUsersController } from './customer-users.controller';
import { CustomerUsersService } from './customer-users.service';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { Tenant } from '../index.entities';
import { CustomersService, MailService, TenantsService } from '../index.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant]),
    CustomersModule,
    UsersModule,
  ],
  controllers: [CustomerUsersController],
  providers: [CustomerUsersService, MailService, TenantsService, CustomersService],
  exports: [CustomerUsersService],
})
export class CustomerUsersModule {}