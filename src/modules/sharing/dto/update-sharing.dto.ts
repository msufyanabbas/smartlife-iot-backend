import { PartialType } from '@nestjs/swagger';
import { CreateShareDto } from './create-sharing.dto';

export class UpdateShareDto extends PartialType(CreateShareDto) {}
