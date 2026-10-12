import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TestCommandDto {
  @ApiProperty({ example: 'reboot' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ example: { interval: 600 } })
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;
}

/**
 * `POST /converters/:id/test`.
 *
 * `payload` is deliberately untyped: a sample is a JSON object for a `json`
 * converter, a hex or base64 string for a `codec` one, and whatever the vendor
 * sends for a script. A `@IsObject()` here would make the codec case — the one
 * the test panel is most needed for — impossible to submit.
 *
 * The global ValidationPipe is `forbidNonWhitelisted`, so the three properties
 * below are the entire accepted surface; anything else is a 400 naming the key.
 */
export class TestConverterDto {
  @ApiProperty({
    description:
      'The sample message. An object, or a hex/base64 string for a codec converter.',
    examples: {
      ttn: { value: { uplink_message: { decoded_payload: { temp: 231 } } } },
      lorawan: { value: '01755C03673401046865' },
    },
  })
  payload: any;

  @ApiPropertyOptional({
    description:
      'Execution context — deviceKey, devEUI, fPort. A per-message fPort wins over the configured one.',
    example: { fPort: 85, devEUI: '24e124445c123456' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Downlink converters only: the command to encode.',
    type: TestCommandDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TestCommandDto)
  command?: TestCommandDto;
}
