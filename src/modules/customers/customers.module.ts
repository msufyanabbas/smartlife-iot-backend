import { Permission } from '@modules/index.entities';
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
    // Permission is registered here rather than importing PermissionsModule:
    // the customers service only READS the catalogue to validate and seed
    // grants, and an import would add another edge to the Users/Customers
    // forwardRef knot below.
    TypeOrmModule.forFeature([Customer, User, Permission]),
    forwardRef(() => UsersModule),   // ← forwardRef here
    TenantsModule,
    MailModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerListener],
  exports: [CustomersService],
})
export class CustomersModule {}