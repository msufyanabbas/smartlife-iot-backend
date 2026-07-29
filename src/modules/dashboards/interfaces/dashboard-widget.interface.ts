// src/modules/dashboards/interfaces/dashboard-widget.interface.ts
//
// The shape of one widget instance stored in Dashboard.widgets (jsonb).
//
// NOTE ON STORAGE: there is no `Dashboard.configuration` column — `widgets` is
// the jsonb array that holds these, and it is what every existing read path
// already uses. These records live there.
//
// NOTE ON SHAPE: this is a flat grid layout (row/col/width/height) with a
// single-device `datasource`. The older WidgetConfig in
// @common/interfaces/widget.interface.ts used nested `position {x,y,w,h}` and a
// multi-device `dataSource { deviceIds[] }`. Both shapes coexist in the column:
// dashboards seeded before this change still carry the old one, so anything
// reading widgets generically (Dashboard.getUsedDevices(), the WebSocket
// dashboard subscription) accepts either.

export interface DashboardWidgetDatasource {
  deviceId?: string;
  /** Denormalised at write time so rendering needs no devices lookup. */
  deviceName?: string;
  entityType?: 'DEVICE' | 'ASSET';
  telemetryKeys?: string[];
  timeWindow?: string;
  aggregation?: string;
}

export interface DashboardWidgetConfig {
  /** uuid, generated server-side on creation. */
  id: string;
  /** FK to WidgetType.id — validated on write. */
  widgetTypeId: string;
  /** Denormalised WidgetType.descriptor.alias, e.g. 'gauge'. */
  widgetTypeAlias: string;
  title: string;
  row: number;
  col: number;
  width: number;
  height: number;
  datasource: DashboardWidgetDatasource;
  /** WidgetType.descriptor.defaultConfig merged with caller overrides. */
  config: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/** A widget returned by GET /dashboards/:id/widgets, with its lookups resolved. */
export interface EnrichedDashboardWidget extends DashboardWidgetConfig {
  widgetType: {
    id: string;
    name: string;
    alias: string | null;
    type: string | null;
    category: string;
    description: string | null;
    defaultConfig: Record<string, any> | null;
    dataConfig: Record<string, any> | null;
    sizeX: number | null;
    sizeY: number | null;
  } | null;
  device: {
    id: string;
    name: string;
    status: string;
    type: string;
    deviceKey: string;
  } | null;
}
