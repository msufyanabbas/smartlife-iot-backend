import { WidgetTypeCategory } from '../entities/widget-type.entity';

/**
 * System widgets seed data
 * These are pre-installed widgets that come with the platform
 */
export const SYSTEM_WIDGETS = [
  {
    name: 'Time-Series Line Chart',
    description: 'Display time-series data as a line chart',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 12,
      sizeY: 6,
      minSizeX: 6,
      minSizeY: 4,
      resources: [
        {
          url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
        },
      ],
      templateHtml: `
        <div class="chart-container" style="height: 100%; width: 100%;">
          <canvas id="lineChart"></canvas>
        </div>
      `,
      templateCss: `
        .chart-container {
          padding: 10px;
        }
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          title: 'Line Chart Settings',
          properties: {
            showLegend: {
              type: 'boolean',
              title: 'Show Legend',
              default: true,
            },
            showGrid: { type: 'boolean', title: 'Show Grid', default: true },
            lineWidth: { type: 'number', title: 'Line Width', default: 2 },
            fillArea: { type: 'boolean', title: 'Fill Area', default: false },
          },
        },
      },
      defaultConfig: {
        showLegend: true,
        showGrid: true,
        lineWidth: 2,
        fillArea: false,
      },
    },
  },
  {
    name: 'Latest Value Card',
    description: 'Display latest telemetry value as a card',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 4,
      sizeY: 3,
      minSizeX: 3,
      minSizeY: 2,
      templateHtml: `
        <div class="value-card">
          <div class="card-title">{{title}}</div>
          <div class="card-value">{{value}} <span class="unit">{{unit}}</span></div>
          <div class="card-timestamp">{{timestamp}}</div>
        </div>
      `,
      templateCss: `
        .value-card {
          padding: 20px;
          text-align: center;
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .card-title {
          font-size: 14px;
          color: #666;
          margin-bottom: 10px;
        }
        .card-value {
          font-size: 32px;
          font-weight: bold;
          color: #333;
        }
        .unit {
          font-size: 18px;
          color: #999;
        }
        .card-timestamp {
          font-size: 12px;
          color: #999;
          margin-top: 10px;
        }
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', title: 'Card Title' },
            unit: { type: 'string', title: 'Unit' },
            decimals: { type: 'number', title: 'Decimal Places', default: 2 },
          },
        },
      },
    },
  },
  {
    name: 'Temperature Gauge',
    description: 'Circular gauge for temperature display',
    category: WidgetTypeCategory.GAUGES,
    bundleFqn: 'Gauges',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6,
      sizeY: 6,
      resources: [
        {
          url: 'https://cdn.jsdelivr.net/npm/canvas-gauges@2.1.7/gauge.min.js',
        },
      ],
      templateHtml: `
        <div class="gauge-container">
          <canvas id="temperatureGauge"></canvas>
        </div>
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            minValue: { type: 'number', title: 'Min Value', default: 0 },
            maxValue: { type: 'number', title: 'Max Value', default: 100 },
            units: { type: 'string', title: 'Units', default: '°C' },
          },
        },
      },
    },
  },
  {
    name: 'Alarms Table',
    description: 'Display alarms in a sortable table',
    category: WidgetTypeCategory.ALARM_WIDGETS,
    bundleFqn: 'Alarms',
    system: true,
    descriptor: {
      type: 'alarm',
      sizeX: 12,
      sizeY: 8,
      templateHtml: `
        <div class="alarms-table">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Type</th>
                <th>Device</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody id="alarmsBody"></tbody>
          </table>
        </div>
      `,
      templateCss: `
        .alarms-table {
          width: 100%;
          height: 100%;
          overflow: auto;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          padding: 10px;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }
        th {
          background-color: #f5f5f5;
          font-weight: 600;
        }
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            pageSize: { type: 'number', title: 'Page Size', default: 10 },
            showAcknowledged: {
              type: 'boolean',
              title: 'Show Acknowledged',
              default: true,
            },
          },
        },
      },
    },
  },
  {
    name: 'Device List Table',
    description: 'Display devices in a table with status',
    category: WidgetTypeCategory.TABLES,
    bundleFqn: 'Tables',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 12,
      sizeY: 8,
      templateHtml: `
        <div class="devices-table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last Activity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="devicesBody"></tbody>
          </table>
        </div>
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            showInactive: {
              type: 'boolean',
              title: 'Show Inactive Devices',
              default: true,
            },
            pageSize: { type: 'number', title: 'Page Size', default: 10 },
          },
        },
      },
    },
  },
  {
    name: 'Map Widget',
    description: 'Display devices on a map',
    category: WidgetTypeCategory.MAPS,
    bundleFqn: 'Maps',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 12,
      sizeY: 10,
      resources: [
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' },
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' },
      ],
      templateHtml: `
        <div id="map" style="height: 100%; width: 100%;"></div>
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            defaultZoom: { type: 'number', title: 'Default Zoom', default: 10 },
            centerLat: { type: 'number', title: 'Center Latitude', default: 0 },
            centerLng: {
              type: 'number',
              title: 'Center Longitude',
              default: 0,
            },
          },
        },
      },
    },
  },
  {
    name: 'Control Button',
    description: 'Button to send RPC commands to devices',
    category: WidgetTypeCategory.CONTROL_WIDGETS,
    bundleFqn: 'Controls',
    system: true,
    descriptor: {
      type: 'rpc',
      sizeX: 4,
      sizeY: 2,
      templateHtml: `
        <div class="control-button-container">
          <button id="controlBtn" class="control-button">{{buttonText}}</button>
        </div>
      `,
      templateCss: `
        .control-button-container {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .control-button {
          padding: 15px 30px;
          font-size: 16px;
          border: none;
          border-radius: 4px;
          background-color: #007bff;
          color: white;
          cursor: pointer;
        }
        .control-button:hover {
          background-color: #0056b3;
        }
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            buttonText: {
              type: 'string',
              title: 'Button Text',
              default: 'Control',
            },
            rpcMethod: { type: 'string', title: 'RPC Method' },
            rpcParams: { type: 'object', title: 'RPC Parameters' },
          },
        },
      },
    },
  },
  {
    name: 'Switch Widget',
    description: 'Toggle switch for device control',
    category: WidgetTypeCategory.CONTROL_WIDGETS,
    bundleFqn: 'Controls',
    system: true,
    descriptor: {
      type: 'rpc',
      sizeX: 4,
      sizeY: 2,
      templateHtml: `
        <div class="switch-container">
          <label class="switch-label">{{label}}</label>
          <label class="switch">
            <input type="checkbox" id="switchInput">
            <span class="slider"></span>
          </label>
        </div>
      `,
      templateCss: `
        .switch-container {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px;
        }
        .switch {
          position: relative;
          display: inline-block;
          width: 60px;
          height: 34px;
        }
        .switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: #ccc;
          transition: .4s;
          border-radius: 34px;
        }
        .slider:before {
          position: absolute;
          content: "";
          height: 26px;
          width: 26px;
          left: 4px;
          bottom: 4px;
          background-color: white;
          transition: .4s;
          border-radius: 50%;
        }
        input:checked + .slider {
          background-color: #2196F3;
        }
        input:checked + .slider:before {
          transform: translateX(26px);
        }
      `,
    },
  },
  {
    name: 'Bar Chart',
    description: 'Display data as a bar chart',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 12,
      sizeY: 6,
      resources: [
        {
          url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
        },
      ],
      templateHtml: `
        <div class="chart-container">
          <canvas id="barChart"></canvas>
        </div>
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            horizontal: {
              type: 'boolean',
              title: 'Horizontal Bars',
              default: false,
            },
            showLegend: {
              type: 'boolean',
              title: 'Show Legend',
              default: true,
            },
          },
        },
      },
    },
  },
  {
    name: 'Pie Chart',
    description: 'Display data as a pie chart',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6,
      sizeY: 6,
      resources: [
        {
          url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
        },
      ],
      templateHtml: `
        <div class="chart-container">
          <canvas id="pieChart"></canvas>
        </div>
      `,
      settingsSchema: {
        schema: {
          type: 'object',
          properties: {
            showLegend: {
              type: 'boolean',
              title: 'Show Legend',
              default: true,
            },
            doughnut: {
              type: 'boolean',
              title: 'Doughnut Style',
              default: false,
            },
          },
        },
      },
    },
  },
];

/**
 * System widget bundles
 */
export const SYSTEM_BUNDLES = [
  {
    title: 'Charts',
    description: 'Chart widgets for data visualization',
    order: 1,
    system: true,
  },
  {
    title: 'Cards',
    description: 'Card widgets for displaying key values',
    order: 2,
    system: true,
  },
  {
    title: 'Gauges',
    description: 'Gauge widgets for metrics display',
    order: 3,
    system: true,
  },
  {
    title: 'Controls',
    description: 'Control widgets for device interaction',
    order: 4,
    system: true,
  },
  {
    title: 'Tables',
    description: 'Table widgets for data lists',
    order: 5,
    system: true,
  },
  {
    title: 'Alarms',
    description: 'Alarm-related widgets',
    order: 6,
    system: true,
  },
  {
    title: 'Maps',
    description: 'Map widgets for location display',
    order: 7,
    system: true,
  },
];
