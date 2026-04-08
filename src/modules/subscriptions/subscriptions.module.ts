import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { Subscription } from './entities/subscription.entity';
import { Device, EmailTemplate, Payment, Tenant } from '../index.entities';
import { InvoicePdfService } from './invoice-pdf.service';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Tenant, Device, EmailTemplate, Payment]),
    forwardRef(() => UsersModule),
    MailModule,
    EmailTemplatesModule,
  ],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    InvoicePdfService,
    // ← UsersService, MailService, EmailTemplatesService removed
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}