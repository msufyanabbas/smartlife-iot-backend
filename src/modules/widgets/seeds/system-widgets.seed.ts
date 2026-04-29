// src/database/seeds/widgets.seed.ts
// Run once at startup or via seeder to populate the system widget library.
// Every widget here is system: true — only super admins can edit/delete.

import { DataSource } from 'typeorm';
import { WidgetBundle } from '@modules/widgets/entities/widget-bundle.entity';
import { WidgetType } from '@modules/widgets/entities/widget-type.entity';
import { WidgetTypeCategory } from '@common/enums/widget-type.enum';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function schema(props: Record<string, any>): { schema: { type: 'object'; title?: string; properties: Record<string, any> }; form?: any[] } {
  return { schema: { type: 'object', properties: props } };
}

function numProp(title: string, def: number) {
  return { type: 'number', title, default: def };
}

function strProp(title: string, def: string) {
  return { type: 'string', title, default: def };
}

function boolProp(title: string, def: boolean) {
  return { type: 'boolean', title, default: def };
}

function colorProp(title: string, def: string) {
  return { type: 'string', title, default: def, format: 'color' };
}

// ─── BUNDLES ──────────────────────────────────────────────────────────────────

export const WIDGET_BUNDLES = [
  { title: 'Charts',           description: 'Time-series and comparative chart widgets',          order: 1,  system: true },
  { title: 'Cards',            description: 'Single-value stat and info card widgets',            order: 2,  system: true },
  { title: 'Gauges',           description: 'Circular and linear gauge display widgets',          order: 3,  system: true },
  { title: 'Control Widgets',  description: 'Interactive device control and RPC widgets',         order: 4,  system: true },
  { title: 'Maps',             description: 'Geographic location and route display widgets',      order: 5,  system: true },
  { title: 'Tables',           description: 'Tabular data, entity list, and event log widgets',  order: 6,  system: true },
  { title: 'Alarm Widgets',    description: 'Alarm list, count, and notification widgets',       order: 7,  system: true },
  { title: 'Environment',      description: 'Indoor/outdoor environment monitoring widgets',     order: 8,  system: true },
  { title: 'Energy',           description: 'Power, energy, and utility monitoring widgets',     order: 9,  system: true },
  { title: 'Navigation',       description: 'Date range, time window, and filter widgets',       order: 10, system: true },
  { title: 'Static',           description: 'Static HTML, markdown, and media widgets',          order: 11, system: true },
];

// ─── DESCRIPTOR TYPE HELPER ──────────────────────────────────────────────────────
type DescriptorType = 'timeseries' | 'latest' | 'rpc' | 'alarm' | 'static';

interface WidgetSeedEntry {
  name: string;
  description: string;
  category: WidgetTypeCategory;
  bundleFqn: string;
  system: boolean;
  tags: string[];
  descriptor: {
    type: DescriptorType;
    sizeX: number;
    sizeY: number;
    minSizeX?: number;
    minSizeY?: number;
    resources?: Array<{ url: string }>;
    templateHtml?: string;
    templateCss?: string;
    controllerScript?: string;
    settingsSchema?: {
      schema: {
        type: 'object';
        title?: string;
        properties: Record<string, any>;
      };
      form?: any[];
    };
    defaultConfig?: Record<string, any>;
  };
}

// ─── WIDGET TYPES ─────────────────────────────────────────────────────────────

export const WIDGET_TYPES: WidgetSeedEntry[] = [

  // ══════════════════════════════════════════════════════════════════════════
  // CHARTS
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Time Series Line Chart',
    description: 'Displays time-series telemetry as a smooth line chart with configurable time window.',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 8, sizeY: 4, minSizeX: 4, minSizeY: 3,
      resources: [{ url: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js' }],
      templateHtml: `<div style="position:relative;width:100%;height:100%;padding:8px"><canvas id="chart"></canvas></div>`,
      templateCss: ``,
      controllerScript: `
const ctx = self.ctx;
const canvas = document.getElementById('chart');
const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const colors = s.colors || ['#6c63ff','#00e5a0','#ffb547','#4da6ff','#ff4d6a'];
const data = { labels: [], datasets: keys.map((k, i) => ({
  label: k, data: [], borderColor: colors[i % colors.length],
  borderWidth: s.lineWidth ?? 2, pointRadius: 0, tension: 0.3,
  fill: s.fillArea ? { target: 'origin', above: colors[i % colors.length] + '22' } : false,
}))};
const chart = new Chart(canvas, {
  type: 'line', data,
  options: {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: s.showLegend ?? true, position: 'top',
        labels: { color: '#888', font: { size: 11 }, boxWidth: 12 } },
    },
    scales: {
      x: { ticks: { color: '#666', maxTicksLimit: 8 }, grid: { color: '#1e1e30' } },
      y: { ticks: { color: '#666' }, grid: { color: '#1e1e30' },
        ...(s.yMin !== undefined && { min: s.yMin }),
        ...(s.yMax !== undefined && { max: s.yMax }),
      },
    },
  },
});
ctx.subscribeToTelemetry(keys, (update) => {
  const t = new Date().toTimeString().slice(0,8);
  data.labels.push(t);
  if (data.labels.length > (s.maxPoints ?? 60)) data.labels.shift();
  data.datasets.forEach((ds, i) => {
    const k = keys[i]; const v = update.data[k];
    ds.data.push(v !== undefined ? parseFloat(v) || 0 : ds.data[ds.data.length-1] ?? 0);
    if (ds.data.length > (s.maxPoints ?? 60)) ds.data.shift();
  });
  chart.update('quiet');
});
ctx.onDestroy(() => { chart.destroy(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({
        showLegend: boolProp('Show Legend', true),
        fillArea:   boolProp('Fill Area Under Line', false),
        lineWidth:  numProp('Line Width', 2),
        maxPoints:  numProp('Max Data Points', 60),
        yMin:       { type: 'number', title: 'Y Axis Min (leave empty for auto)' },
        yMax:       { type: 'number', title: 'Y Axis Max (leave empty for auto)' },
        colors:     { type: 'array', title: 'Series Colors', items: { type: 'string', format: 'color' } },
      }),
      defaultConfig: { showLegend: true, fillArea: false, lineWidth: 2, maxPoints: 60 },
    },
    tags: ['chart', 'line', 'timeseries', 'real-time'],
  },

  {
    name: 'Time Series Bar Chart',
    description: 'Displays time-series data as vertical or horizontal bars.',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 8, sizeY: 4, minSizeX: 4, minSizeY: 3,
      resources: [{ url: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js' }],
      templateHtml: `<div style="position:relative;width:100%;height:100%;padding:8px"><canvas id="chart"></canvas></div>`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const colors = s.colors || ['#6c63ff','#00e5a0','#ffb547','#4da6ff'];
const data = { labels: [], datasets: keys.map((k,i) => ({
  label: k, data: [], backgroundColor: colors[i%colors.length]+'cc',
  borderColor: colors[i%colors.length], borderWidth: 1,
}))};
const chart = new Chart(document.getElementById('chart'), {
  type: s.horizontal ? 'bar' : 'bar', data,
  options: {
    responsive: true, maintainAspectRatio: false,
    indexAxis: s.horizontal ? 'y' : 'x',
    plugins: { legend: { display: s.showLegend ?? true, labels: { color: '#888', font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#666' }, grid: { color: '#1e1e30' } },
      y: { ticks: { color: '#666' }, grid: { color: '#1e1e30' } },
    },
  },
});
ctx.subscribeToTelemetry(keys, (update) => {
  data.labels.push(new Date().toTimeString().slice(0,8));
  if (data.labels.length > 20) data.labels.shift();
  data.datasets.forEach((ds, i) => {
    const v = update.data[keys[i]];
    ds.data.push(v !== undefined ? parseFloat(v) || 0 : 0);
    if (ds.data.length > 20) ds.data.shift();
  });
  chart.update('quiet');
});
ctx.onDestroy(() => { chart.destroy(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({
        horizontal: boolProp('Horizontal Bars', false),
        showLegend: boolProp('Show Legend', true),
        colors:     { type: 'array', title: 'Colors', items: { type: 'string', format: 'color' } },
      }),
      defaultConfig: { horizontal: false, showLegend: true },
    },
    tags: ['chart', 'bar', 'timeseries'],
  },

  {
    name: 'Pie / Doughnut Chart',
    description: 'Shows proportional breakdown of latest values across multiple keys.',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 4, sizeY: 4, minSizeX: 3, minSizeY: 3,
      resources: [{ url: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js' }],
      templateHtml: `<div style="position:relative;width:100%;height:100%;padding:8px"><canvas id="chart"></canvas></div>`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const colors = ['#6c63ff','#00e5a0','#ffb547','#4da6ff','#ff4d6a','#a855f7','#ec4899'];
const data = { labels: keys, datasets: [{ data: keys.map(() => 0), backgroundColor: colors, borderWidth: 2, borderColor: '#13131e' }] };
const chart = new Chart(document.getElementById('chart'), {
  type: s.doughnut ? 'doughnut' : 'pie', data,
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { color: '#888', font: { size: 11 } } } },
    ...(s.doughnut && { cutout: '60%' }),
  },
});
ctx.subscribeToTelemetry(keys, (update) => {
  data.datasets[0].data = keys.map(k => parseFloat(update.data[k]) || 0);
  chart.update();
});
ctx.onDestroy(() => { chart.destroy(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({ doughnut: boolProp('Doughnut Style', false) }),
      defaultConfig: { doughnut: false },
    },
    tags: ['chart', 'pie', 'doughnut', 'proportion'],
  },

  {
    name: 'Scatter Plot',
    description: 'Plots two telemetry keys as X/Y scatter points over time.',
    category: WidgetTypeCategory.CHARTS,
    bundleFqn: 'Charts',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 6, sizeY: 4, minSizeX: 4, minSizeY: 3,
      resources: [{ url: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js' }],
      templateHtml: `<div style="position:relative;width:100%;height:100%;padding:8px"><canvas id="chart"></canvas></div>`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const xKey = keys[0]; const yKey = keys[1] || keys[0];
let latestX = 0, latestY = 0;
const dataset = { label: s.label || (xKey + ' vs ' + yKey), data: [], backgroundColor: '#6c63ff88', pointRadius: 4 };
const chart = new Chart(document.getElementById('chart'), {
  type: 'scatter',
  data: { datasets: [dataset] },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { title: { display: true, text: xKey, color: '#888' }, ticks: { color: '#666' }, grid: { color: '#1e1e30' } },
      y: { title: { display: true, text: yKey, color: '#888' }, ticks: { color: '#666' }, grid: { color: '#1e1e30' } },
    },
  },
});
ctx.subscribeToTelemetry(keys, (update) => {
  if (update.data[xKey] !== undefined) latestX = parseFloat(update.data[xKey]) || 0;
  if (update.data[yKey] !== undefined) latestY = parseFloat(update.data[yKey]) || 0;
  dataset.data.push({ x: latestX, y: latestY });
  if (dataset.data.length > 200) dataset.data.shift();
  chart.update('quiet');
});
ctx.onDestroy(() => { chart.destroy(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({ label: strProp('Series Label', 'X vs Y') }),
      defaultConfig: { label: 'X vs Y' },
    },
    tags: ['chart', 'scatter', 'correlation'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CARDS
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Value Card',
    description: 'Displays the latest value of a single telemetry key in large text.',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 3, sizeY: 2, minSizeX: 2, minSizeY: 2,
      templateHtml: `
<div class="card">
  <div class="label" id="label"></div>
  <div class="value" id="value">—</div>
  <div class="unit" id="unit"></div>
  <div class="ts" id="ts">No data yet</div>
</div>`,
      templateCss: `
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:4px;padding:12px;}
.label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em;}
.value{font-size:42px;font-weight:800;color:#e8e8f5;transition:color 0.3s;line-height:1;}
.value.pulse{color:#9d97ff;}
.unit{font-size:16px;color:#888;}
.ts{font-size:10px;color:#555;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0];
document.getElementById('label').textContent = s.label || k || 'value';
document.getElementById('unit').textContent = s.unit || '';
ctx.subscribeToTelemetry([k], (update) => {
  const v = update.data[k];
  if (v === undefined) return;
  const el = document.getElementById('value');
  const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const num = parseFloat(raw);
  el.textContent = (!isNaN(num) && s.decimals !== undefined) ? num.toFixed(s.decimals) : raw;
  el.classList.add('pulse');
  setTimeout(() => el.classList.remove('pulse'), 500);
  document.getElementById('ts').textContent = new Date().toTimeString().slice(0,8);
  if (s.thresholds?.length) {
    let color = s.defaultColor || '#e8e8f5';
    s.thresholds.forEach(t => { if (num >= t.value) color = t.color; });
    el.style.color = color;
  }
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        label:        strProp('Label', ''),
        unit:         strProp('Unit', ''),
        decimals:     numProp('Decimal Places', 1),
        defaultColor: colorProp('Default Color', '#e8e8f5'),
        thresholds: {
          type: 'array', title: 'Color Thresholds',
          items: { type: 'object', properties: {
            value: numProp('Value', 0),
            color: colorProp('Color', '#ff4d6a'),
            label: strProp('Label', ''),
          }},
        },
      }),
      defaultConfig: { decimals: 1, defaultColor: '#e8e8f5' },
    },
    tags: ['card', 'stat', 'value', 'latest'],
  },

  {
    name: 'Delta Card',
    description: 'Shows current value and change since last reading with up/down arrow.',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 3, sizeY: 2, minSizeX: 2, minSizeY: 2,
      templateHtml: `
<div class="card">
  <div class="lbl" id="lbl"></div>
  <div class="val" id="val">—</div>
  <div class="delta" id="delta"></div>
</div>`,
      templateCss: `
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;}
.lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em;}
.val{font-size:38px;font-weight:800;color:#e8e8f5;line-height:1;}
.delta{font-size:13px;font-weight:600;}
.up{color:#00e5a0;}.down{color:#ff4d6a;}.flat{color:#888;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0];
let prev = null;
document.getElementById('lbl').textContent = s.label || k || '';
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k]);
  if (isNaN(v)) return;
  document.getElementById('val').textContent = v.toFixed(s.decimals ?? 1) + ' ' + (s.unit || '');
  if (prev !== null) {
    const d = v - prev; const sign = d > 0 ? '↑' : d < 0 ? '↓' : '→';
    const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const dEl = document.getElementById('delta');
    dEl.textContent = sign + ' ' + Math.abs(d).toFixed(s.decimals ?? 1);
    dEl.className = 'delta ' + cls;
  }
  prev = v;
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        label:    strProp('Label', ''),
        unit:     strProp('Unit', ''),
        decimals: numProp('Decimal Places', 1),
      }),
      defaultConfig: { decimals: 1 },
    },
    tags: ['card', 'delta', 'change', 'trend'],
  },

  {
    name: 'Battery Level Card',
    description: 'Shows device battery percentage with visual battery icon.',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 2, sizeY: 2, minSizeX: 2, minSizeY: 2,
      templateHtml: `
<div class="card">
  <div class="icon"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">—%</div>
  <div class="lbl">Battery</div>
</div>`,
      templateCss: `
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;}
.icon{width:48px;height:24px;border:3px solid #444;border-radius:3px;position:relative;padding:2px;}
.icon::after{content:'';position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:4px;height:10px;background:#444;border-radius:0 2px 2px 0;}
.bar{height:100%;border-radius:1px;transition:width 0.5s,background 0.5s;}
.pct{font-size:28px;font-weight:800;color:#e8e8f5;}
.lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;}`,
      controllerScript: `
const ctx = self.ctx;
const k = ctx.dataSource.telemetryKeys?.[0] || 'battery';
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k] ?? update.data['batteryLevel'] ?? update.data['battery'] ?? 0);
  const bar = document.getElementById('bar');
  const pct = document.getElementById('pct');
  bar.style.width = Math.min(100, Math.max(0, v)) + '%';
  bar.style.background = v > 50 ? '#00e5a0' : v > 20 ? '#ffb547' : '#ff4d6a';
  pct.textContent = v.toFixed(0) + '%';
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({}),
      defaultConfig: {},
    },
    tags: ['card', 'battery', 'status'],
  },

  {
    name: 'Device Status Card',
    description: 'Shows online/offline status of a device with last seen timestamp.',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 3, sizeY: 2, minSizeX: 2, minSizeY: 2,
      templateHtml: `
<div class="card">
  <div class="dot" id="dot"></div>
  <div class="status" id="status">Unknown</div>
  <div class="lbl" id="devlbl"></div>
  <div class="ts" id="ts"></div>
</div>`,
      templateCss: `
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;}
.dot{width:20px;height:20px;border-radius:50%;background:#555;transition:all 0.3s;}
.dot.online{background:#00e5a0;box-shadow:0 0 12px #00e5a0;}
.dot.offline{background:#ff4d6a;}
.status{font-size:20px;font-weight:700;color:#e8e8f5;}
.lbl{font-size:11px;color:#888;}
.ts{font-size:10px;color:#555;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
document.getElementById('devlbl').textContent = s.deviceName || ctx.deviceId?.slice(0,12) || '';
let timer = setInterval(() => {
  const last = parseInt(localStorage.getItem('sl_last_' + ctx.deviceId) || '0');
  const isOnline = Date.now() - last < (s.timeoutSeconds ?? 120) * 1000;
  document.getElementById('dot').className = 'dot ' + (isOnline ? 'online' : 'offline');
  document.getElementById('status').textContent = isOnline ? 'Online' : 'Offline';
  document.getElementById('ts').textContent = last ? 'Last seen: ' + new Date(last).toTimeString().slice(0,8) : 'Never seen';
}, 5000);
const k = ctx.dataSource.telemetryKeys?.[0];
ctx.subscribeToTelemetry([k], () => {
  localStorage.setItem('sl_last_' + ctx.deviceId, Date.now().toString());
});
ctx.onDestroy(() => { clearInterval(timer); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({
        deviceName:     strProp('Device Label', ''),
        timeoutSeconds: numProp('Offline Timeout (seconds)', 120),
      }),
      defaultConfig: { timeoutSeconds: 120 },
    },
    tags: ['card', 'status', 'online', 'offline'],
  },

  {
    name: 'Multi-Value Summary Card',
    description: 'Shows up to 6 telemetry values in a grid of labeled tiles.',
    category: WidgetTypeCategory.CARDS,
    bundleFqn: 'Cards',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6, sizeY: 3, minSizeX: 4, minSizeY: 2,
      templateHtml: `<div class="grid" id="grid"></div>`,
      templateCss: `
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;height:100%;padding:8px;align-content:center;}
.tile{background:#1a1a28;border:1px solid #2a2a40;border-radius:6px;padding:10px;text-align:center;}
.tval{font-size:24px;font-weight:800;color:#e8e8f5;line-height:1;}
.tlbl{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const grid = document.getElementById('grid');
const tiles = {};
keys.forEach(k => {
  const t = document.createElement('div'); t.className = 'tile';
  t.innerHTML = '<div class="tval" id="tv_' + k + '">—</div><div class="tlbl">' + (s.labels?.[k] || k) + '</div>';
  grid.appendChild(t); tiles[k] = document.getElementById('tv_' + k);
});
ctx.subscribeToTelemetry(keys, (update) => {
  keys.forEach(k => {
    if (tiles[k] && update.data[k] !== undefined) {
      const v = parseFloat(update.data[k]);
      tiles[k].textContent = isNaN(v) ? String(update.data[k]) : v.toFixed(s.decimals ?? 1) + (s.units?.[k] || '');
    }
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        decimals: numProp('Decimal Places', 1),
        labels: { type: 'object', title: 'Custom Labels (key → label)', additionalProperties: { type: 'string' } },
        units:  { type: 'object', title: 'Units per Key (key → unit)',  additionalProperties: { type: 'string' } },
      }),
      defaultConfig: { decimals: 1 },
    },
    tags: ['card', 'multi', 'summary', 'grid'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // GAUGES
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Radial Gauge',
    description: 'Semicircular arc gauge with configurable min/max and color thresholds.',
    category: WidgetTypeCategory.GAUGES,
    bundleFqn: 'Gauges',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 3, sizeY: 3, minSizeX: 2, minSizeY: 2,
      templateHtml: `
<div class="gc">
  <svg viewBox="0 0 200 120" id="svg">
    <path d="M20 110 A80 80 0 0 1 180 110" fill="none" stroke="#1e1e30" stroke-width="16" stroke-linecap="round"/>
    <path d="M20 110 A80 80 0 0 1 180 110" fill="none" stroke="#6c63ff" stroke-width="16" stroke-linecap="round"
          stroke-dasharray="251.3" stroke-dashoffset="251.3" id="gfill" style="transition:all 0.5s"/>
    <text x="100" y="100" text-anchor="middle" fill="#e8e8f5" font-size="28" font-weight="800" id="gval">—</text>
    <text x="100" y="115" text-anchor="middle" fill="#888" font-size="11" id="gunit"></text>
  </svg>
  <div class="glbl" id="glbl"></div>
  <div class="gmm"><span id="gmin"></span><span id="gmax"></span></div>
</div>`,
      templateCss: `
.gc{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:8px;}
svg{width:min(100%,200px);height:auto;}
.glbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px;}
.gmm{display:flex;justify-content:space-between;width:min(100%,200px);font-size:10px;color:#555;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0];
const min = s.min ?? 0; const max = s.max ?? 100;
const arc = 251.3;
document.getElementById('gunit').textContent = s.unit || '';
document.getElementById('glbl').textContent = s.label || k || '';
document.getElementById('gmin').textContent = min;
document.getElementById('gmax').textContent = max;
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k]); if (isNaN(v)) return;
  const pct = Math.min(1, Math.max(0, (v - min) / (max - min)));
  document.getElementById('gfill').setAttribute('stroke-dashoffset', (arc - pct * arc).toFixed(1));
  document.getElementById('gval').textContent = v.toFixed(s.decimals ?? 1);
  let color = s.defaultColor || '#6c63ff';
  (s.thresholds || []).forEach(t => { if (v >= t.value) color = t.color; });
  document.getElementById('gfill').setAttribute('stroke', color);
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        label:        strProp('Label', ''),
        unit:         strProp('Unit', ''),
        min:          numProp('Minimum Value', 0),
        max:          numProp('Maximum Value', 100),
        decimals:     numProp('Decimal Places', 1),
        defaultColor: colorProp('Default Color', '#6c63ff'),
        thresholds: {
          type: 'array', title: 'Color Thresholds',
          items: { type: 'object', properties: {
            value: numProp('From Value', 0),
            color: colorProp('Color', '#ff4d6a'),
          }},
        },
      }),
      defaultConfig: { min: 0, max: 100, decimals: 1, defaultColor: '#6c63ff' },
    },
    tags: ['gauge', 'radial', 'arc', 'latest'],
  },

  {
    name: 'Linear Progress Bar',
    description: 'Horizontal progress bar showing a value within a range.',
    category: WidgetTypeCategory.GAUGES,
    bundleFqn: 'Gauges',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 4, sizeY: 2, minSizeX: 3, minSizeY: 1,
      templateHtml: `
<div class="pg">
  <div class="hdr"><span class="lbl" id="lbl"></span><span class="val" id="val">—</span></div>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="mm"><span id="mn"></span><span id="mx"></span></div>
</div>`,
      templateCss: `
.pg{display:flex;flex-direction:column;justify-content:center;height:100%;padding:12px;gap:8px;}
.hdr{display:flex;justify-content:space-between;align-items:center;}
.lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.06em;}
.val{font-size:20px;font-weight:700;color:#e8e8f5;}
.track{height:12px;background:#1e1e30;border-radius:6px;overflow:hidden;}
.fill{height:100%;border-radius:6px;background:#6c63ff;transition:width 0.5s,background 0.5s;}
.mm{display:flex;justify-content:space-between;font-size:10px;color:#555;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0];
const min = s.min ?? 0; const max = s.max ?? 100;
document.getElementById('lbl').textContent = s.label || k || '';
document.getElementById('mn').textContent = min + (s.unit || '');
document.getElementById('mx').textContent = max + (s.unit || '');
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k]); if (isNaN(v)) return;
  const pct = Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  document.getElementById('val').textContent = v.toFixed(s.decimals ?? 1) + (s.unit || '');
  const fill = document.getElementById('fill');
  fill.style.width = pct + '%';
  let color = '#6c63ff';
  (s.thresholds || []).forEach(t => { if (v >= t.value) color = t.color; });
  fill.style.background = color;
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        label:     strProp('Label', ''),
        unit:      strProp('Unit', ''),
        min:       numProp('Min', 0),
        max:       numProp('Max', 100),
        decimals:  numProp('Decimals', 1),
        thresholds: {
          type: 'array', title: 'Thresholds',
          items: { type: 'object', properties: { value: numProp('From', 0), color: colorProp('Color', '#ff4d6a') } },
        },
      }),
      defaultConfig: { min: 0, max: 100, decimals: 1 },
    },
    tags: ['gauge', 'progress', 'bar', 'linear'],
  },

  {
    name: 'Thermometer',
    description: 'Visual thermometer display for temperature telemetry.',
    category: WidgetTypeCategory.GAUGES,
    bundleFqn: 'Gauges',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 2, sizeY: 4, minSizeX: 2, minSizeY: 3,
      templateHtml: `
<div class="tc">
  <svg viewBox="0 0 60 200" width="60">
    <rect x="22" y="10" width="16" height="140" rx="8" fill="#1e1e30" stroke="#2a2a40" stroke-width="1"/>
    <rect x="24" y="12" width="12" height="136" rx="6" fill="#111"/>
    <rect x="24" id="tfill" width="12" rx="6" fill="#6c63ff" style="transition:all 0.5s" y="148" height="0"/>
    <circle cx="30" cy="166" r="14" fill="#6c63ff" id="tbulb" style="transition:fill 0.5s"/>
    <circle cx="30" cy="166" r="10" fill="#1e1e30" opacity="0.4"/>
  </svg>
  <div class="tval" id="tval">—</div>
  <div class="tunit" id="tunit"></div>
</div>`,
      templateCss: `
.tc{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:4px;}
.tval{font-size:28px;font-weight:800;color:#e8e8f5;}
.tunit{font-size:14px;color:#888;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0] || 'temperature';
const min = s.min ?? -20; const max = s.max ?? 60;
document.getElementById('tunit').textContent = s.unit || '°C';
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k]); if (isNaN(v)) return;
  document.getElementById('tval').textContent = v.toFixed(s.decimals ?? 1);
  const pct = Math.min(1, Math.max(0, (v - min) / (max - min)));
  const fillH = pct * 136;
  const fill = document.getElementById('tfill');
  fill.setAttribute('height', fillH.toFixed(0));
  fill.setAttribute('y', (148 - fillH).toFixed(0));
  const color = v > (s.hotThreshold ?? 35) ? '#ff4d6a' : v < (s.coldThreshold ?? 10) ? '#4da6ff' : '#6c63ff';
  fill.setAttribute('fill', color);
  document.getElementById('tbulb').setAttribute('fill', color);
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        unit:          strProp('Unit', '°C'),
        min:           numProp('Min Temperature', -20),
        max:           numProp('Max Temperature', 60),
        decimals:      numProp('Decimals', 1),
        hotThreshold:  numProp('Hot Threshold (red)', 35),
        coldThreshold: numProp('Cold Threshold (blue)', 10),
      }),
      defaultConfig: { unit: '°C', min: -20, max: 60, decimals: 1, hotThreshold: 35, coldThreshold: 10 },
    },
    tags: ['gauge', 'thermometer', 'temperature'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONTROL WIDGETS
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Switch Panel',
    description: 'Toggle switches for controlling multiple device outputs (e.g. WS558 relays).',
    category: WidgetTypeCategory.CONTROL_WIDGETS,
    bundleFqn: 'Control Widgets',
    system: true,
    descriptor: {
      type: 'rpc',
      sizeX: 6, sizeY: 3, minSizeX: 3, minSizeY: 2,
      templateHtml: `<div class="sp" id="sp"></div>`,
      templateCss: `
.sp{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:10px;height:100%;padding:12px;align-content:center;}
.swi{display:flex;flex-direction:column;align-items:center;gap:6px;}
.swl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.05em;text-align:center;}
.swt{width:48px;height:26px;background:#1e1e30;border-radius:13px;position:relative;cursor:pointer;border:1px solid #2a2a40;transition:all 0.2s;}
.swt.on{background:#00e5a0;border-color:#00e5a0;}
.swth{width:20px;height:20px;background:#e8e8f5;border-radius:10px;position:absolute;top:2px;left:2px;transition:left 0.2s;}
.swt.on .swth{left:24px;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || ['switch_1','switch_2','switch_3','switch_4'];
const labels = s.labels || {};
const sp = document.getElementById('sp');
keys.forEach(k => {
  const item = document.createElement('div'); item.className = 'swi';
  const lbl = document.createElement('div'); lbl.className = 'swl';
  lbl.textContent = labels[k] || k.replace('switch_', 'SW ').replace('_', ' ');
  const swt = document.createElement('div'); swt.className = 'swt'; swt.id = 'sw_' + k;
  const th  = document.createElement('div'); th.className = 'swth';
  swt.appendChild(th); item.appendChild(lbl); item.appendChild(swt); sp.appendChild(item);
  swt.addEventListener('click', () => {
    const isOn = !swt.classList.contains('on');
    swt.classList.toggle('on', isOn);
    ctx.sendCommand(s.command || 'control_switch', { switches: { [k]: isOn ? 'on' : 'off' } });
  });
});
ctx.subscribeToTelemetry(keys, (update) => {
  keys.forEach(k => {
    const el = document.getElementById('sw_' + k); if (!el) return;
    const v = update.data[k];
    if (v !== undefined) el.classList.toggle('on', v === true || v === 1 || v === 'on');
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        command: strProp('RPC Command', 'control_switch'),
        labels: { type: 'object', title: 'Switch Labels (key → label)', additionalProperties: { type: 'string' } },
      }),
      defaultConfig: { command: 'control_switch' },
    },
    tags: ['control', 'switch', 'relay', 'rpc', 'ws558'],
  },

  {
    name: 'Slider Control',
    description: 'Sends a numeric value to the device via RPC when slider is moved.',
    category: WidgetTypeCategory.CONTROL_WIDGETS,
    bundleFqn: 'Control Widgets',
    system: true,
    descriptor: {
      type: 'rpc',
      sizeX: 4, sizeY: 2, minSizeX: 3, minSizeY: 2,
      templateHtml: `
<div class="sl">
  <div class="hdr"><span class="lbl" id="lbl"></span><span class="vdsp" id="vdsp">—</span></div>
  <input type="range" class="rng" id="rng"/>
  <div class="mm"><span id="mn"></span><span id="mx"></span></div>
</div>`,
      templateCss: `
.sl{display:flex;flex-direction:column;justify-content:center;height:100%;padding:16px;gap:10px;}
.hdr{display:flex;justify-content:space-between;}
.lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.06em;}
.vdsp{font-size:20px;font-weight:700;color:#9d97ff;}
.rng{width:100%;accent-color:#6c63ff;}
.mm{display:flex;justify-content:space-between;font-size:10px;color:#555;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const k = ctx.dataSource.telemetryKeys?.[0];
const min = s.min ?? 0; const max = s.max ?? 100; const step = s.step ?? 1;
const rng = document.getElementById('rng');
rng.min = min; rng.max = max; rng.step = step;
document.getElementById('lbl').textContent = s.label || k || 'Value';
document.getElementById('mn').textContent = min + (s.unit || '');
document.getElementById('mx').textContent = max + (s.unit || '');
let debounce;
rng.addEventListener('input', () => {
  const v = parseFloat(rng.value);
  document.getElementById('vdsp').textContent = v.toFixed(s.decimals ?? 0) + (s.unit || '');
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    ctx.sendCommand(s.command || 'set_value', { [k || 'value']: v });
  }, 300);
});
ctx.subscribeToTelemetry([k], (update) => {
  const v = parseFloat(update.data[k]); if (!isNaN(v)) rng.value = v;
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        label:    strProp('Label', ''),
        unit:     strProp('Unit', ''),
        command:  strProp('RPC Command', 'set_value'),
        min:      numProp('Minimum', 0),
        max:      numProp('Maximum', 100),
        step:     numProp('Step', 1),
        decimals: numProp('Decimals', 0),
      }),
      defaultConfig: { min: 0, max: 100, step: 1, decimals: 0, command: 'set_value' },
    },
    tags: ['control', 'slider', 'rpc', 'dimmer'],
  },

  {
    name: 'Push Button',
    description: 'Single button that sends an RPC command to the device on click.',
    category: WidgetTypeCategory.CONTROL_WIDGETS,
    bundleFqn: 'Control Widgets',
    system: true,
    descriptor: {
      type: 'rpc',
      sizeX: 3, sizeY: 2, minSizeX: 2, minSizeY: 1,
      templateHtml: `<div class="bc"><button class="pbtn" id="btn"></button><div class="resp" id="resp"></div></div>`,
      templateCss: `
.bc{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;}
.pbtn{padding:12px 28px;border:2px solid #6c63ff;background:rgba(108,99,255,0.1);color:#9d97ff;font-size:14px;font-weight:700;border-radius:6px;cursor:pointer;letter-spacing:0.04em;text-transform:uppercase;transition:all 0.15s;}
.pbtn:hover{background:rgba(108,99,255,0.25);}
.pbtn:active{transform:scale(0.97);}
.pbtn.sending{border-color:#ffb547;color:#ffb547;}
.resp{font-size:11px;color:#555;height:16px;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const btn = document.getElementById('btn');
btn.textContent = s.label || 'Send Command';
btn.addEventListener('click', async () => {
  btn.classList.add('sending');
  btn.disabled = true;
  document.getElementById('resp').textContent = 'Sending…';
  try {
    await ctx.sendCommand(s.command || 'rpc_command', s.params || {});
    document.getElementById('resp').textContent = '✓ Sent at ' + new Date().toTimeString().slice(0,8);
  } catch(e) {
    document.getElementById('resp').textContent = '✕ Error: ' + e.message;
  }
  btn.classList.remove('sending');
  btn.disabled = false;
});`,
      settingsSchema: schema({
        label:   strProp('Button Label', 'Send Command'),
        command: strProp('RPC Command', 'rpc_command'),
        params:  { type: 'object', title: 'Command Parameters', additionalProperties: true },
      }),
      defaultConfig: { label: 'Send Command', command: 'rpc_command', params: {} },
    },
    tags: ['control', 'button', 'rpc', 'command'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MAPS
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Device Location Map',
    description: 'Shows device GPS position on an OpenStreetMap map with live updates.',
    category: WidgetTypeCategory.MAPS,
    bundleFqn: 'Maps',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6, sizeY: 5, minSizeX: 4, minSizeY: 3,
      resources: [
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' },
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' },
      ],
      templateHtml: `<div id="map" style="width:100%;height:100%;"></div>`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const map = L.map('map').setView([s.centerLat ?? 24.7, s.centerLng ?? 46.7], s.zoom ?? 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 19
}).addTo(map);
let marker = null;
const latKey = s.latKey || 'latitude';
const lngKey = s.lngKey || 'longitude';
ctx.subscribeToTelemetry([latKey, lngKey], (update) => {
  const lat = parseFloat(update.data[latKey]); const lng = parseFloat(update.data[lngKey]);
  if (isNaN(lat) || isNaN(lng)) return;
  if (!marker) {
    marker = L.marker([lat, lng]).addTo(map);
    marker.bindPopup(s.popupText || ctx.deviceId?.slice(0,8) || 'Device');
    if (s.followDevice) map.setView([lat, lng], map.getZoom());
  } else {
    marker.setLatLng([lat, lng]);
    if (s.followDevice) map.panTo([lat, lng]);
  }
});
ctx.onDestroy(() => { map.remove(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({
        centerLat:    numProp('Initial Center Latitude', 24.7),
        centerLng:    numProp('Initial Center Longitude', 46.7),
        zoom:         numProp('Initial Zoom Level', 13),
        latKey:       strProp('Latitude Telemetry Key', 'latitude'),
        lngKey:       strProp('Longitude Telemetry Key', 'longitude'),
        popupText:    strProp('Marker Popup Text', 'Device'),
        followDevice: boolProp('Follow Device on Map', true),
      }),
      defaultConfig: { centerLat: 24.7, centerLng: 46.7, zoom: 13, latKey: 'latitude', lngKey: 'longitude', followDevice: true },
    },
    tags: ['map', 'location', 'gps', 'leaflet', 'tracking'],
  },

  {
    name: 'Route Tracker Map',
    description: 'Draws the device\'s GPS route as a polyline on the map.',
    category: WidgetTypeCategory.MAPS,
    bundleFqn: 'Maps',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 8, sizeY: 5, minSizeX: 4, minSizeY: 3,
      resources: [
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' },
        { url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' },
      ],
      templateHtml: `<div id="map" style="width:100%;height:100%;"></div>`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const map = L.map('map').setView([s.centerLat ?? 24.7, s.centerLng ?? 46.7], s.zoom ?? 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM', maxZoom: 19 }).addTo(map);
const route = []; let polyline = null; let marker = null;
const latKey = s.latKey || 'latitude'; const lngKey = s.lngKey || 'longitude';
ctx.subscribeToTelemetry([latKey, lngKey], (update) => {
  const lat = parseFloat(update.data[latKey]); const lng = parseFloat(update.data[lngKey]);
  if (isNaN(lat) || isNaN(lng)) return;
  route.push([lat, lng]);
  if (route.length > (s.maxPoints ?? 500)) route.shift();
  if (!polyline) { polyline = L.polyline(route, { color: '#6c63ff', weight: 3 }).addTo(map); }
  else { polyline.setLatLngs(route); }
  if (!marker) { marker = L.circleMarker([lat, lng], { radius: 8, fillColor: '#00e5a0', fillOpacity: 1, color: '#fff', weight: 2 }).addTo(map); }
  else { marker.setLatLng([lat, lng]); }
  if (s.followDevice) map.panTo([lat, lng]);
});
ctx.onDestroy(() => { map.remove(); ctx.unsubscribeFromTelemetry(); });`,
      settingsSchema: schema({
        centerLat:    numProp('Center Latitude', 24.7),
        centerLng:    numProp('Center Longitude', 46.7),
        zoom:         numProp('Zoom', 13),
        latKey:       strProp('Latitude Key', 'latitude'),
        lngKey:       strProp('Longitude Key', 'longitude'),
        followDevice: boolProp('Follow Device', true),
        maxPoints:    numProp('Max Route Points', 500),
      }),
      defaultConfig: { centerLat: 24.7, centerLng: 46.7, zoom: 13, latKey: 'latitude', lngKey: 'longitude', followDevice: true, maxPoints: 500 },
    },
    tags: ['map', 'route', 'track', 'gps', 'polyline'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TABLES
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Telemetry Event Log',
    description: 'Scrolling log of all incoming telemetry values with timestamp.',
    category: WidgetTypeCategory.TABLES,
    bundleFqn: 'Tables',
    system: true,
    descriptor: {
      type: 'timeseries',
      sizeX: 6, sizeY: 4, minSizeX: 4, minSizeY: 3,
      templateHtml: `<div class="log" id="log"></div>`,
      templateCss: `
.log{height:100%;overflow-y:auto;font-family:monospace;font-size:11px;padding:4px;}
.log::-webkit-scrollbar{width:4px;}
.log::-webkit-scrollbar-thumb{background:#2a2a40;border-radius:2px;}
.row{display:flex;gap:8px;padding:4px 8px;border-bottom:1px solid #1e1e30;align-items:center;}
.row:hover{background:#1a1a28;}
.ts{color:#555;flex-shrink:0;width:64px;}
.key{color:#9d97ff;flex-shrink:0;min-width:80px;}
.val{color:#00e5a0;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const log = document.getElementById('log');
const max = s.maxRows ?? 100;
ctx.subscribeToTelemetry(keys, (update) => {
  const ts = new Date().toTimeString().slice(0,8);
  const relevant = keys.length ? keys : Object.keys(update.data);
  relevant.forEach(k => {
    if (update.data[k] === undefined) return;
    const v = update.data[k];
    const row = document.createElement('div'); row.className = 'row';
    const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
    row.innerHTML = '<span class="ts">' + ts + '</span><span class="key">' + k + '</span><span class="val">' + vStr + '</span>';
    log.insertBefore(row, log.firstChild);
    if (log.children.length > max) log.removeChild(log.lastChild);
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({ maxRows: numProp('Max Rows', 100) }),
      defaultConfig: { maxRows: 100 },
    },
    tags: ['table', 'log', 'events', 'history'],
  },

  {
    name: 'Latest Values Table',
    description: 'Table showing the latest value of each configured telemetry key.',
    category: WidgetTypeCategory.TABLES,
    bundleFqn: 'Tables',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 5, sizeY: 4, minSizeX: 3, minSizeY: 2,
      templateHtml: `
<div class="tbl-wrap">
  <table class="tbl" id="tbl">
    <thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>`,
      templateCss: `
.tbl-wrap{height:100%;overflow:auto;}
.tbl{width:100%;border-collapse:collapse;font-size:12px;}
th{background:#1a1a28;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;padding:8px 12px;text-align:left;border-bottom:2px solid #2a2a40;position:sticky;top:0;}
td{padding:7px 12px;border-bottom:1px solid #1e1e30;color:#e8e8f5;}
tr:hover td{background:#1a1a28;}
.key-cell{color:#9d97ff;font-family:monospace;font-size:11px;}
.val-cell{color:#00e5a0;font-weight:600;}
.ts-cell{color:#555;font-size:10px;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const keys = ctx.dataSource.telemetryKeys || [];
const labels = s.labels || {};
const units = s.units || {};
const tbody = document.getElementById('tbody');
const rows = {};
keys.forEach(k => {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td class="key-cell">' + (labels[k] || k) + '</td><td class="val-cell" id="v_' + k + '">—</td><td class="ts-cell" id="t_' + k + '">—</td>';
  tbody.appendChild(tr); rows[k] = tr;
});
ctx.subscribeToTelemetry(keys, (update) => {
  keys.forEach(k => {
    if (update.data[k] === undefined) return;
    const v = update.data[k];
    const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const vEl = document.getElementById('v_' + k);
    const tEl = document.getElementById('t_' + k);
    if (vEl) vEl.textContent = vStr + (units[k] ? ' ' + units[k] : '');
    if (tEl) tEl.textContent = new Date().toTimeString().slice(0,8);
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        labels: { type: 'object', title: 'Key Labels', additionalProperties: { type: 'string' } },
        units:  { type: 'object', title: 'Units per Key', additionalProperties: { type: 'string' } },
      }),
      defaultConfig: {},
    },
    tags: ['table', 'latest', 'values', 'key-value'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ALARM WIDGETS
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Active Alarms Table',
    description: 'Lists all active alarms for the subscribed device with severity and time.',
    category: WidgetTypeCategory.ALARM_WIDGETS,
    bundleFqn: 'Alarm Widgets',
    system: true,
    descriptor: {
      type: 'alarm',
      sizeX: 8, sizeY: 4, minSizeX: 4, minSizeY: 3,
      templateHtml: `
<div class="aw">
  <div class="ahdr">
    <span class="atitle">Active Alarms</span>
    <span class="acnt" id="acnt">0</span>
  </div>
  <div class="alist" id="alist"><div class="empty">No active alarms</div></div>
</div>`,
      templateCss: `
.aw{display:flex;flex-direction:column;height:100%;}
.ahdr{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #1e1e30;}
.atitle{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;}
.acnt{background:#ff4d6a22;color:#ff4d6a;border:1px solid #ff4d6a;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700;}
.alist{flex:1;overflow-y:auto;padding:4px;}
.arow{padding:8px 12px;border-bottom:1px solid #1e1e30;display:flex;flex-direction:column;gap:3px;}
.arow:hover{background:#1a1a28;}
.asev{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;}
.aname{font-size:12px;color:#e8e8f5;}
.ameta{font-size:10px;color:#555;display:flex;gap:12px;}
.CRITICAL,.ERROR{color:#ff4d6a;}.WARNING{color:#ffb547;}.INFO{color:#4da6ff;}
.empty{display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:12px;}`,
      controllerScript: `
const ctx = self.ctx;
const alarms = [];
const list = document.getElementById('alist');
const cnt = document.getElementById('acnt');
function render() {
  cnt.textContent = alarms.length;
  if (!alarms.length) { list.innerHTML = '<div class="empty">No active alarms</div>'; return; }
  list.innerHTML = alarms.map(a => \`
    <div class="arow">
      <span class="asev \${a.severity}">\${a.severity}</span>
      <span class="aname">\${a.name || 'Alarm'}</span>
      <div class="ameta">
        <span>\${a.message || ''}</span>
        <span>\${a.triggeredAt ? new Date(a.triggeredAt).toLocaleTimeString() : ''}</span>
      </div>
    </div>\`).join('');
}
ctx.onAlarmTriggered?.((a) => { alarms.unshift(a); if (alarms.length > 50) alarms.pop(); render(); });
ctx.onAlarmCleared?.((a)   => { const i = alarms.findIndex(x => x.id === a.id); if (i > -1) alarms.splice(i, 1); render(); });
ctx.onAlarmResolved?.((a)  => { const i = alarms.findIndex(x => x.id === a.id); if (i > -1) alarms.splice(i, 1); render(); });
render();`,
      settingsSchema: schema({ maxAlarms: numProp('Max Alarms Shown', 50) }),
      defaultConfig: { maxAlarms: 50 },
    },
    tags: ['alarm', 'table', 'active', 'notifications'],
  },

  {
    name: 'Alarm Count Card',
    description: 'Shows count of active alarms by severity as colored counters.',
    category: WidgetTypeCategory.ALARM_WIDGETS,
    bundleFqn: 'Alarm Widgets',
    system: true,
    descriptor: {
      type: 'alarm',
      sizeX: 6, sizeY: 2, minSizeX: 4, minSizeY: 2,
      templateHtml: `
<div class="ac">
  <div class="sev critical"><div class="scnt" id="cnt_CRITICAL">0</div><div class="slbl">Critical</div></div>
  <div class="sev error"><div class="scnt" id="cnt_ERROR">0</div><div class="slbl">Error</div></div>
  <div class="sev warning"><div class="scnt" id="cnt_WARNING">0</div><div class="slbl">Warning</div></div>
  <div class="sev info"><div class="scnt" id="cnt_INFO">0</div><div class="slbl">Info</div></div>
</div>`,
      templateCss: `
.ac{display:flex;height:100%;align-items:stretch;}
.sev{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-right:1px solid #1e1e30;}
.sev:last-child{border-right:none;}
.scnt{font-size:36px;font-weight:800;line-height:1;}
.slbl{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;}
.critical .scnt,.critical .slbl{color:#ff4d6a;}
.error .scnt,.error .slbl{color:#ff4d6a;}
.warning .scnt,.warning .slbl{color:#ffb547;}
.info .scnt,.info .slbl{color:#4da6ff;}`,
      controllerScript: `
const ctx = self.ctx;
const counts = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
function update(sev, delta) {
  counts[sev] = Math.max(0, (counts[sev] || 0) + delta);
  const el = document.getElementById('cnt_' + sev);
  if (el) el.textContent = counts[sev];
}
ctx.onAlarmTriggered?.((a) => update(a.severity?.toUpperCase(), 1));
ctx.onAlarmCleared?.((a)   => update(a.severity?.toUpperCase(), -1));
ctx.onAlarmResolved?.((a)  => update(a.severity?.toUpperCase(), -1));`,
      settingsSchema: schema({}),
      defaultConfig: {},
    },
    tags: ['alarm', 'count', 'severity', 'summary'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ENVIRONMENT
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Indoor Environment Monitor',
    description: 'Combined temperature, humidity, CO2 and air quality display for indoor sensors.',
    category: WidgetTypeCategory.OTHER,
    bundleFqn: 'Environment',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6, sizeY: 3, minSizeX: 4, minSizeY: 2,
      templateHtml: `<div class="env" id="env"></div>`,
      templateCss: `
.env{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;height:100%;padding:12px;align-content:center;}
.tile{background:#1a1a28;border:1px solid #2a2a40;border-radius:8px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:6px;}
.icon{font-size:22px;}
.tval{font-size:22px;font-weight:800;color:#e8e8f5;line-height:1;}
.tlbl{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.06em;}
.tunit{font-size:12px;color:#888;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const cfg = s.metrics || [
  { key: 'temperature',  label: 'Temp',     unit: '°C', icon: '🌡️', decimals: 1 },
  { key: 'humidity',     label: 'Humidity', unit: '%',  icon: '💧', decimals: 0 },
  { key: 'co2',          label: 'CO₂',      unit: 'ppm',icon: '💨', decimals: 0 },
  { key: 'pressure',     label: 'Pressure', unit: 'hPa',icon: '🔵', decimals: 0 },
];
const env = document.getElementById('env');
const tiles = {};
cfg.forEach(m => {
  const t = document.createElement('div'); t.className = 'tile';
  t.innerHTML = '<div class="icon">' + m.icon + '</div><div class="tval" id="v_' + m.key + '">—</div><div class="tunit">' + m.unit + '</div><div class="tlbl">' + m.label + '</div>';
  env.appendChild(t); tiles[m.key] = m;
});
const keys = cfg.map(m => m.key);
ctx.subscribeToTelemetry(keys, (update) => {
  Object.entries(tiles).forEach(([k, m]) => {
    const v = parseFloat(update.data[k]);
    const el = document.getElementById('v_' + k);
    if (el && !isNaN(v)) el.textContent = v.toFixed(m.decimals ?? 1);
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({
        metrics: {
          type: 'array', title: 'Metrics Configuration',
          items: { type: 'object', properties: {
            key:      strProp('Telemetry Key', 'temperature'),
            label:    strProp('Display Label', 'Temp'),
            unit:     strProp('Unit', '°C'),
            icon:     strProp('Emoji Icon', '🌡️'),
            decimals: numProp('Decimal Places', 1),
          }},
        },
      }),
      defaultConfig: {},
    },
    tags: ['environment', 'temperature', 'humidity', 'co2', 'indoor', 'air-quality'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ENERGY
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'Power Meter',
    description: 'Shows voltage, current, active power and energy consumption for smart meters.',
    category: WidgetTypeCategory.OTHER,
    bundleFqn: 'Energy',
    system: true,
    descriptor: {
      type: 'latest',
      sizeX: 6, sizeY: 3, minSizeX: 4, minSizeY: 2,
      templateHtml: `
<div class="pm">
  <div class="prow"><div class="plbl">Voltage</div><div class="pval" id="v_voltage">—</div><div class="punit">V</div></div>
  <div class="prow"><div class="plbl">Current</div><div class="pval" id="v_current">—</div><div class="punit">A</div></div>
  <div class="prow main"><div class="plbl">Active Power</div><div class="pval lg" id="v_active_power">—</div><div class="punit">W</div></div>
  <div class="prow"><div class="plbl">Total Energy</div><div class="pval" id="v_energy">—</div><div class="punit">kWh</div></div>
  <div class="prow"><div class="plbl">Power Factor</div><div class="pval" id="v_power_factor">—</div><div class="punit"></div></div>
</div>`,
      templateCss: `
.pm{display:flex;flex-direction:column;height:100%;padding:12px;gap:2px;}
.prow{display:flex;align-items:center;padding:6px 8px;border-bottom:1px solid #1e1e30;gap:8px;}
.prow.main{background:#1a1a28;border-radius:4px;margin:4px 0;}
.plbl{font-size:11px;color:#888;flex:1;text-transform:uppercase;letter-spacing:0.06em;}
.pval{font-size:18px;font-weight:700;color:#9d97ff;min-width:60px;text-align:right;}
.pval.lg{font-size:26px;color:#00e5a0;}
.punit{font-size:12px;color:#555;min-width:30px;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
const map = {
  voltage:      { el: 'v_voltage',      dec: 1 },
  current:      { el: 'v_current',      dec: 2 },
  active_power: { el: 'v_active_power', dec: 1 },
  energy:       { el: 'v_energy',       dec: 2 },
  power_factor: { el: 'v_power_factor', dec: 3 },
};
const keys = Object.keys(map);
ctx.subscribeToTelemetry(keys, (update) => {
  Object.entries(map).forEach(([k, m]) => {
    const v = parseFloat(update.data[k]);
    const el = document.getElementById(m.el);
    if (el && !isNaN(v)) el.textContent = v.toFixed(m.dec);
  });
});
ctx.onDestroy(() => ctx.unsubscribeFromTelemetry());`,
      settingsSchema: schema({}),
      defaultConfig: {},
    },
    tags: ['energy', 'power', 'voltage', 'current', 'meter', 'ws558'],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // STATIC
  // ══════════════════════════════════════════════════════════════════════════

  {
    name: 'HTML Panel',
    description: 'Renders custom static HTML content. No data source required.',
    category: WidgetTypeCategory.OTHER,
    bundleFqn: 'Static',
    system: true,
    descriptor: {
      type: 'static',
      sizeX: 4, sizeY: 2, minSizeX: 2, minSizeY: 1,
      templateHtml: `<div class="html-panel" id="content"></div>`,
      templateCss: `
.html-panel{width:100%;height:100%;overflow:auto;padding:12px;display:flex;align-items:center;justify-content:center;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
document.getElementById('content').innerHTML = s.html || '<p style="color:#888;font-size:14px">Configure HTML content in widget settings.</p>';`,
      settingsSchema: schema({
        html: { type: 'string', title: 'HTML Content', format: 'html' },
      }),
      defaultConfig: { html: '<h2 style="color:#9d97ff;text-align:center">Custom HTML</h2>' },
    },
    tags: ['static', 'html', 'custom'],
  },

  {
    name: 'Label / Text Widget',
    description: 'Displays a configurable title and description text block on the dashboard.',
    category: WidgetTypeCategory.OTHER,
    bundleFqn: 'Static',
    system: true,
    descriptor: {
      type: 'static',
      sizeX: 4, sizeY: 2, minSizeX: 2, minSizeY: 1,
      templateHtml: `
<div class="lw">
  <div class="ltitle" id="ltitle"></div>
  <div class="ldesc" id="ldesc"></div>
</div>`,
      templateCss: `
.lw{display:flex;flex-direction:column;justify-content:center;height:100%;padding:16px;gap:6px;}
.ltitle{font-size:20px;font-weight:700;color:#e8e8f5;}
.ldesc{font-size:13px;color:#888;line-height:1.5;}`,
      controllerScript: `
const ctx = self.ctx; const s = ctx.settings;
document.getElementById('ltitle').textContent = s.title || 'Section Title';
document.getElementById('ldesc').textContent = s.description || '';`,
      settingsSchema: schema({
        title:       strProp('Title', 'Section Title'),
        description: strProp('Description', ''),
      }),
      defaultConfig: { title: 'Section Title', description: '' },
    },
    tags: ['static', 'label', 'text', 'section'],
  },
];

// ─── SEEDER FUNCTION ──────────────────────────────────────────────────────────

export async function seedWidgets(dataSource: DataSource): Promise<void> {
  const bundleRepo = dataSource.getRepository(WidgetBundle);
  const typeRepo   = dataSource.getRepository(WidgetType);

  console.log('🎨 Seeding widget bundles…');
  const bundleMap: Record<string, WidgetBundle> = {};

  for (const b of WIDGET_BUNDLES) {
    let bundle = await bundleRepo.findOne({ where: { title: b.title } });
    if (!bundle) {
      bundle = bundleRepo.create(b);
      bundle = await bundleRepo.save(bundle);
      console.log(`  ✅ Bundle: ${b.title}`);
    } else {
      console.log(`  ⏭  Bundle exists: ${b.title}`);
    }
    bundleMap[b.title] = bundle;
  }

  console.log('\n🔧 Seeding widget types…');
  for (const wt of WIDGET_TYPES) {
    const existing = await typeRepo.findOne({ where: { name: wt.name } });
    if (!existing) {
      // Instantiate directly to avoid TypeORM create() union-type confusion
      // and cast descriptor.type to the literal union expected by the entity.
      const entity = new WidgetType();
      entity.name        = wt.name;
      entity.description = wt.description;
      entity.category    = wt.category;
      entity.bundleFqn   = wt.bundleFqn;
      entity.system      = true;
      entity.tags        = wt.tags as string[];
      entity.descriptor  = {
        ...wt.descriptor,
        type: wt.descriptor.type as 'timeseries' | 'latest' | 'rpc' | 'alarm' | 'static',
      };
      await typeRepo.save(entity);
      console.log(`  ✅ Widget: ${wt.name}`);
    } else {
      console.log(`  ⏭  Widget exists: ${wt.name}`);
    }
  }

  console.log('\n✨ Widget library seeded successfully.');
  console.log(`   ${WIDGET_BUNDLES.length} bundles | ${WIDGET_TYPES.length} widget types`);
}