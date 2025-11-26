import { PartialType } from '@nestjs/swagger';
import { CreateSolutionTemplateDto } from './create-solution-template.dto';

export class UpdateSolutionTemplateDto extends PartialType(
  CreateSolutionTemplateDto,
) {}
