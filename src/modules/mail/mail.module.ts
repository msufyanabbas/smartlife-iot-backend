import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './mail.service';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [ConfigModule, EmailTemplatesModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
