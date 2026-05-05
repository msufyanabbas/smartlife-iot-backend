import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerUsersController } from './customer-users.controller';
import { CustomerUsersService } from './customer-users.service';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { TenantsModule } from '../tenants/tenants.module';
import { MailModule } from '../mail/mail.module';
import { CustomerUserLimit, Role } from '../index.entities';
import { AssignmentModule } from '../assignments/assignment.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role, CustomerUserLimit]),
    forwardRef(() => CustomersModule),  // ← forwardRef here
    forwardRef(() => UsersModule), 
    TenantsModule,
    MailModule,
    AssignmentModule
  ],
  controllers: [CustomerUsersController],
  providers: [CustomerUsersService],
  exports: [CustomerUsersService],
})
export class CustomerUsersModule {}