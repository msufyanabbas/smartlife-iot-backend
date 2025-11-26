import { PartialType } from '@nestjs/swagger';
import { CreateEdgeInstanceDto } from './create-edge-instance.dto';

export class UpdateEdgeInstanceDto extends PartialType(CreateEdgeInstanceDto) {}
