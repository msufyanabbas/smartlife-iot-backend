import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer } from './entities/customers.entity';
import { User } from '../index.entities';
import { MailService, TenantsService } from '../index.service';
import { MailModule, TenantsModule } from '../index.module';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, User]), TenantsModule, MailModule ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}