import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WidgetsController } from './widgets.controller';
import { WidgetTypesService } from './widget-types.service';
import { WidgetBundlesService } from './widget-bundles.service';
import { WidgetType } from './entities/widget-type.entity';
import { WidgetBundle } from './entities/widget-bundle.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WidgetType, WidgetBundle])],
  controllers: [WidgetsController],
  providers: [WidgetTypesService, WidgetBundlesService],
  exports: [WidgetTypesService, WidgetBundlesService],
})
export class WidgetsModule {}
