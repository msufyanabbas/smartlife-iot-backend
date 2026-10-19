import { Module } from '@nestjs/common';
import { CadStandardsService } from './cad-standards.service';
import { CadStandardsController } from './cad-standards.controller';

/**
 * No repositories and no other modules: the standard is a constant table, so
 * this module has nothing to inject and cannot take part in a dependency
 * cycle. FloorPlansModule imports it to classify what it parses.
 */
@Module({
  controllers: [CadStandardsController],
  providers: [CadStandardsService],
  exports: [CadStandardsService],
})
export class CadStandardsModule {}
