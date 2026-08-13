// src/modules/edge/dto/update-edge.dto.ts
import { PartialType } from '@nestjs/swagger';
import { CreateEdgeDto } from './create-edge.dto';

export class UpdateEdgeDto extends PartialType(CreateEdgeDto) {}
