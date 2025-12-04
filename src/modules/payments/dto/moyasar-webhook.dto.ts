// src/modules/payments/dto/stripe-webhook.dto.ts
import { IsString, IsObject, IsOptional } from 'class-validator';

// Webhook DTO for Moyasar
export class MoyasarWebhookDto {
  @IsString()
  type: string;

  @IsOptional()
  data?: any;
}