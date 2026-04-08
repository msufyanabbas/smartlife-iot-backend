import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { Subscription } from './entities/subscription.entity';
import { Device, EmailTemplate, Payment, Tenant, User } from '../index.entities';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { UsersModule } from '../index.module';

@Global() // Make it globally available
@Module({
  imports: [TypeOrmModule.forFeature([Subscription, User, Tenant, Device, EmailTemplate, Payment]), forwardRef(() => UsersModule)],  // ← import the whole module, not just the service],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, UsersService, MailService, EmailTemplatesService, InvoicePdfService],
  exports: [SubscriptionsService, UsersService, MailService, EmailTemplatesService],
})
export class SubscriptionsModule {}
