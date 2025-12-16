import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerUsersController } from './customer-users.controller';
import { CustomerUsersService } from './customer-users.service';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    CustomersModule,
    UsersModule,
  ],
  controllers: [CustomerUsersController],
  providers: [CustomerUsersService],
  exports: [CustomerUsersService],
})
export class CustomerUsersModule {}