import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer } from './entities/customers.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CustomerListener } from './customers.listener';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, User]),
    forwardRef(() => UsersModule),   // ← forwardRef here
    TenantsModule,
    MailModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerListener],
  exports: [CustomersService],
})
export class CustomersModule {}