import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerUsersController } from './customer-users.controller';
import { CustomerUsersService } from './customer-users.service';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { TenantsModule } from '../tenants/tenants.module';
import { MailModule } from '../mail/mail.module';
import { Role } from '../index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role]),
    forwardRef(() => CustomersModule),  // ← forwardRef here
    UsersModule,
    TenantsModule,
    MailModule,
  ],
  controllers: [CustomerUsersController],
  providers: [CustomerUsersService],
  exports: [CustomerUsersService],
})
export class CustomerUsersModule {}