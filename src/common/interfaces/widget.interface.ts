// ══════════════════════════════════════════════════════════════════════════
// INTERFACES (What gets stored in JSONB)
// ══════════════════════════════════════════════════════════════════════════

export interface WidgetConfig {
  id: string;  // UUID generated when widget added to dashboard
  
  // Widget template reference
  widgetTypeId?: string;  // References WidgetType.id (optional for custom widgets)
  type: 'chart' | 'gauge' | 'map' | 'table' | 'stat' | 'timeseries' | 'heatmap' | 'control';
  
  // Display
  title: string;
  position: {
    x: number;      // Grid column (0-11)
    y: number;      // Grid row
    w: number;      // Width in grid units (1-12)
    h: number;      // Height in grid units
  };
  
  // Data source (where does this widget get data?)
  dataSource: {
    deviceIds?: string[];           // Which devices to show
    assetIds?: string[];            // Or which assets
    telemetryKeys?: string[];       // Which telemetry keys (temperature, humidity)
    attributeKeys?: string[];       // Or which attributes
    aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count' | 'latest';
    timeRange?: string;             // '1h', '24h', '7d', '30d', 'custom'
    refreshInterval?: number;       // Seconds between updates (for polling)
    useWebSocket?: boolean;         // Use WebSocket for real-time updates
  };
  
  // Visualization settings
  visualization: {
    chartType?: 'line' | 'bar' | 'pie' | 'doughnut' | 'area' | 'scatter';
    colors?: string[];              // Chart colors
    showLegend?: boolean;
    showGrid?: boolean;
    showTooltip?: boolean;
    unit?: string;                  // °C, %, kW, etc.
    decimals?: number;              // Decimal places to show
    min?: number;                   // Min value for gauges
    max?: number;                   // Max value for gauges
    thresholds?: Array<{            // Color thresholds
      value: number;
      color: string;
      label?: string;
    }>;
  };
  
  // Additional filters
  filters?: Record<string, any>;
  
  // Custom settings (widget-type specific)
  settings?: Record<string, any>;
}