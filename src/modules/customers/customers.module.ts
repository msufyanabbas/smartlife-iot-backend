import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer } from './entities/customers.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CustomerListener } from './customers.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, User]),
    TenantsModule,
    MailModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerListener],
  exports: [CustomersService],
})
export class CustomersModule {}