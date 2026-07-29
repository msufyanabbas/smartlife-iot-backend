// src/database/seeds/widget/widget.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WidgetBundle, WidgetType } from '@modules/index.entities';
import { WidgetTypeCategory } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds the "Smart Life Core Widgets" bundle and its 10 widget types.
 *
 * ── Field mapping ─────────────────────────────────────────────────────────────
 * The spec for these widgets describes `alias`, `type`, `defaultConfig`,
 * `dataConfig`, `sizeX` and `sizeY` as top-level fields. WidgetType has none of
 * those as columns — it carries a single `descriptor` jsonb that already owns
 * `type` / `sizeX` / `sizeY` / `defaultConfig`. All six therefore live inside
 * `descriptor`, which needs no migration and keeps one source of truth for how
 * a widget renders. `alias` and `dataConfig` were added to the descriptor type
 * on the entity (type-only change, the column is jsonb).
 *
 * ── Bundle linkage ────────────────────────────────────────────────────────────
 * There is no bundleId FK. WidgetType↔WidgetBundle membership is the string
 * `WidgetType.bundleFqn === WidgetBundle.title`, which is what
 * WidgetBundlesService.getWidgetsInBundle() queries. These rows therefore store
 * the bundle's exact title. (The pre-existing seeder writes lowercase
 * `bundleFqn` values — 'charts' vs the bundle titled 'Charts' — so those bundles
 * resolve to zero widgets. This seeder does not reproduce that mismatch.)
 *
 * Idempotent: upserts by the unique `name` column, so re-running refreshes the
 * definitions in place rather than colliding.
 */
@Injectable()
export class WidgetSeeder implements ISeeder {
  private readonly logger = new Logger(WidgetSeeder.name);

  /** Title of the bundle these widgets belong to — also their `bundleFqn`. */
  private static readonly BUNDLE_TITLE = 'Smart Life Core Widgets';

  constructor(
    @InjectRepository(WidgetBundle)
    private readonly bundleRepository: Repository<WidgetBundle>,
    @InjectRepository(WidgetType)
    private readonly widgetTypeRepository: Repository<WidgetType>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting core widget seeding...');

    const bundle = await this.upsertBundle();
    const { created, refreshed } = await this.upsertWidgetTypes(bundle.title);

    this.logger.log(
      `🎉 Core widget seeding completed! Bundle: "${bundle.title}", ` +
        `widget types created: ${created}, refreshed: ${refreshed}`,
    );
  }

  // ── Bundle ────────────────────────────────────────────────────────────────

  private async upsertBundle(): Promise<WidgetBundle> {
    const title = WidgetSeeder.BUNDLE_TITLE;

    const existing = await this.bundleRepository.findOne({
      where: { title },
      withDeleted: true,
    });

    if (existing) {
      existing.deletedAt = undefined;
      existing.description =
        'Core widget library shipped with the Smart Life IoT Platform';
      existing.system = true;
      existing.tenantId = undefined;
      existing.order = 0;
      const saved = await this.bundleRepository.save(existing);
      this.logger.log(`♻️  Refreshed widget bundle: ${title}`);
      return saved;
    }

    const bundle = this.bundleRepository.create({
      title,
      description:
        'Core widget library shipped with the Smart Life IoT Platform',
      // `system` is the column name (there is no `isSystem` on WidgetBundle);
      // tenantId stays null so every tenant can see the bundle.
      system: true,
      tenantId: undefined,
      order: 0,
    });

    const saved = await this.bundleRepository.save(bundle);
    this.logger.log(`✅ Created widget bundle: ${title}`);
    return saved;
  }

  // ── Widget types ──────────────────────────────────────────────────────────

  private async upsertWidgetTypes(
    bundleFqn: string,
  ): Promise<{ created: number; refreshed: number }> {
    let created = 0;
    let refreshed = 0;

    for (const spec of WidgetSeeder.WIDGET_TYPES) {
      const existing = await this.widgetTypeRepository.findOne({
        where: { name: spec.name },
        withDeleted: true,
      });

      const descriptor = {
        type: spec.type,
        alias: spec.alias,
        sizeX: spec.sizeX,
        sizeY: spec.sizeY,
        minSizeX: spec.minSizeX ?? Math.max(1, Math.floor(spec.sizeX / 2)),
        minSizeY: spec.minSizeY ?? Math.max(1, Math.floor(spec.sizeY / 2)),
        defaultConfig: spec.defaultConfig,
        dataConfig: spec.dataConfig,
      };

      if (existing) {
        existing.deletedAt = undefined;
        existing.description = spec.description;
        existing.category = spec.category;
        existing.bundleFqn = bundleFqn;
        existing.descriptor = descriptor;
        existing.system = true;
        existing.tenantId = undefined;
        existing.deprecated = false;
        existing.tags = spec.tags;
        await this.widgetTypeRepository.save(existing);
        this.logger.log(
          `♻️  Refreshed widget type: ${spec.name.padEnd(18)} (${spec.alias})`,
        );
        refreshed++;
        continue;
      }

      const widgetType = this.widgetTypeRepository.create({
        name: spec.name,
        description: spec.description,
        category: spec.category,
        bundleFqn,
        descriptor,
        system: true,
        tenantId: undefined,
        deprecated: false,
        tags: spec.tags,
      });

      await this.widgetTypeRepository.save(widgetType);
      this.logger.log(
        `✅ Created widget type: ${spec.name.padEnd(18)} (${spec.alias})`,
      );
      created++;
    }

    return { created, refreshed };
  }

  // ── The 10 core widget definitions ────────────────────────────────────────

  private static readonly WIDGET_TYPES: Array<{
    name: string;
    alias: string;
    type: 'timeseries' | 'latest' | 'rpc' | 'alarm' | 'static' | 'control';
    category: WidgetTypeCategory;
    description: string;
    defaultConfig: Record<string, any>;
    dataConfig: Record<string, any>;
    sizeX: number;
    sizeY: number;
    minSizeX?: number;
    minSizeY?: number;
    tags: string[];
  }> = [
    {
      name: 'Timeseries Chart',
      alias: 'timeseries-chart',
      type: 'timeseries',
      category: WidgetTypeCategory.CHARTS,
      description: 'Line chart showing historical telemetry over time',
      defaultConfig: {
        timeWindow: '1h',
        aggregation: 'AVG',
        showLegend: true,
        smooth: true,
      },
      dataConfig: {
        maxDataPoints: 100,
        supportsMultipleKeys: true,
        requiresDevice: true,
      },
      sizeX: 6,
      sizeY: 4,
      tags: ['chart', 'timeseries', 'line'],
    },
    {
      name: 'Gauge',
      alias: 'gauge',
      type: 'latest',
      category: WidgetTypeCategory.GAUGES,
      description: 'Circular gauge showing current value',
      defaultConfig: {
        minValue: 0,
        maxValue: 100,
        unit: '',
        colorRanges: [
          { from: 0, to: 50, color: '#00C48C' },
          { from: 50, to: 80, color: '#FFB300' },
          { from: 80, to: 100, color: '#E53935' },
        ],
      },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: false,
        requiresDevice: true,
      },
      sizeX: 3,
      sizeY: 3,
      tags: ['gauge', 'latest'],
    },
    {
      name: 'Value Card',
      alias: 'value-card',
      type: 'latest',
      category: WidgetTypeCategory.CARDS,
      description: 'Simple card showing latest telemetry value',
      defaultConfig: { unit: '', decimals: 2, showTrend: true, icon: 'sensor' },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: false,
        requiresDevice: true,
      },
      sizeX: 3,
      sizeY: 2,
      tags: ['card', 'latest', 'value'],
    },
    {
      name: 'Bar Chart',
      alias: 'bar-chart',
      type: 'timeseries',
      category: WidgetTypeCategory.CHARTS,
      description: 'Bar chart for comparing values over time',
      defaultConfig: {
        timeWindow: '24h',
        aggregation: 'SUM',
        orientation: 'vertical',
      },
      dataConfig: {
        maxDataPoints: 24,
        supportsMultipleKeys: true,
        requiresDevice: true,
      },
      sizeX: 6,
      sizeY: 4,
      tags: ['chart', 'bar', 'timeseries'],
    },
    {
      name: 'Map',
      alias: 'map',
      type: 'latest',
      category: WidgetTypeCategory.MAPS,
      description: 'Map showing device location',
      defaultConfig: {
        zoom: 10,
        mapType: 'roadmap',
        showTrail: false,
        latitudeKey: 'latitude',
        longitudeKey: 'longitude',
      },
      dataConfig: { supportsMultipleKeys: false, requiresDevice: true },
      sizeX: 6,
      sizeY: 5,
      tags: ['map', 'location', 'geo'],
    },
    {
      name: 'Status Widget',
      alias: 'status',
      type: 'latest',
      category: WidgetTypeCategory.CARDS,
      description: 'Device online/offline status',
      defaultConfig: { showLastSeen: true, showAlarms: true },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: false,
        requiresDevice: true,
      },
      sizeX: 3,
      sizeY: 2,
      tags: ['status', 'device'],
    },
    {
      name: 'Alarm List',
      alias: 'alarm-list',
      type: 'alarm',
      category: WidgetTypeCategory.ALARM_WIDGETS,
      description: 'List of active alarms for linked devices',
      defaultConfig: { maxAlarms: 10, showAcknowledged: false },
      dataConfig: { supportsMultipleKeys: false, requiresDevice: false },
      sizeX: 6,
      sizeY: 4,
      tags: ['alarm', 'list'],
    },
    {
      name: 'Switch Control',
      alias: 'switch',
      // 'control' is a descriptor type added alongside the original five —
      // WidgetTypesService.validateDescriptor() accepts it.
      type: 'control',
      category: WidgetTypeCategory.CONTROL_WIDGETS,
      description: 'Toggle switch for controlling devices',
      defaultConfig: { onValue: true, offValue: false, telemetryKey: 'state' },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: false,
        requiresDevice: true,
      },
      sizeX: 2,
      sizeY: 2,
      tags: ['control', 'switch', 'toggle'],
    },
    {
      name: 'Progress Bar',
      alias: 'progress-bar',
      type: 'latest',
      category: WidgetTypeCategory.GAUGES,
      description: 'Horizontal progress bar showing percentage',
      defaultConfig: {
        minValue: 0,
        maxValue: 100,
        unit: '%',
        color: '#00C4F0',
      },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: false,
        requiresDevice: true,
      },
      sizeX: 4,
      sizeY: 2,
      tags: ['progress', 'bar', 'latest'],
    },
    {
      name: 'Pie Chart',
      alias: 'pie-chart',
      type: 'latest',
      category: WidgetTypeCategory.CHARTS,
      description: 'Pie/donut chart for distribution',
      defaultConfig: {
        chartType: 'donut',
        showLegend: true,
        showPercentage: true,
      },
      dataConfig: {
        maxDataPoints: 1,
        supportsMultipleKeys: true,
        requiresDevice: true,
      },
      sizeX: 4,
      sizeY: 4,
      tags: ['chart', 'pie', 'donut'],
    },
  ];
}
