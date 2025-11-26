import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { validate as isUuid } from 'uuid';

@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value) {
      throw new BadRequestException('ID is required');
    }

    if (!isUuid(value)) {
      throw new BadRequestException('Invalid ID format. Must be a valid UUID');
    }

    return value;
  }
}
