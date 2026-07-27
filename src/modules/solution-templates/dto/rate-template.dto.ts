import { IsNumber, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Replaces the previous inline `@Body() body: { rating: number }`, which the
 * global ValidationPipe could not validate — any value (999, -5, a string)
 * reached the decimal(3,2) column unchecked.
 */
export class RateTemplateDto {
  @ApiProperty({ example: 4.5, minimum: 0, maximum: 5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(5)
  rating: number;
}
