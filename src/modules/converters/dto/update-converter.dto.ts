import { PartialType } from '@nestjs/swagger';
import { CreateConverterDto } from './create-converter.dto';

/**
 * Every field optional. `type` and `direction` are editable: a converter that
 * was created as `json` and turns out to need a script would otherwise have to
 * be deleted and recreated, losing whatever references it. The service
 * re-validates the merged `{type, direction, configuration}` triple, so an edit
 * that leaves the configuration behind is rejected rather than stored.
 */
export class UpdateConverterDto extends PartialType(CreateConverterDto) {}
