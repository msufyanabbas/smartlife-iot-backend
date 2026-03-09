import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer } from './entities/customers.entity';
import { User } from '../index.entities';
import { MailService, TenantsService } from '../index.service';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, User])],
  controllers: [CustomersController],
  providers: [CustomersService, MailService, TenantsService],
  exports: [CustomersService],
})
export class CustomersModule {}