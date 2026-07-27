// src/database/seeds/solution-template/solution-template.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  SolutionTemplateCategory,
  DeviceType,
  AlarmSeverity,
  AlarmCondition,
  NodeType,
} from '@common/enums/index.enum';
import { SolutionTemplate } from '@modules/index.entities';
import { DeviceProtocol } from '@modules/devices/entities/device.entity';
import type { TemplateConfiguration } from '@modules/solution-templates/interfaces/template-configuration.interface';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds the 8 canonical system solution templates.
 *
 * System templates are code-owned: they carry `isSystem: true` and
 * `tenantId: null`, are visible to every tenant, and are refreshed in place on
 * every seed run so spec edits propagate without a database reset. Any system
 * template NOT in this list is soft-deleted (see `pruneStaleSystemTemplates`).
 *
 * ── Value mapping ─────────────────────────────────────────────────────────────
 * The source spec used a few names that do not exist as enum members. Because
 * `devices.type`, `solution_templates.category` and the alarm condition are all
 * backed by Postgres enum types, unmapped literals would fail at insert:
 *
 *   protocol  'MQTT'    → DeviceProtocol.GENERIC_MQTT ('generic_mqtt')
 *   protocol  'COAP'    → DeviceProtocol.COAP
 *   protocol  'HTTP'    → DeviceProtocol.HTTP
 *   condition 'EQUALS'  → AlarmCondition.EQUAL   (the member is EQUAL, not EQUALS)
 *   node type 'filter'  → NodeType.FILTER, 'action' → NodeType.ACTION
 *
 * ── Device types ──────────────────────────────────────────────────────────────
 * Every device spec uses only the six base `devices_type_enum` members —
 * sensor / actuator / gateway / controller / camera / tracker — so this seeder
 * runs against ANY database, including one that has not had the enum-expansion
 * migration applied. Specific hardware roles collapse onto those six:
 *
 *   thermostat, hvac, access control, elevator,
 *   street-light controller, inverter, POS   → controller
 *   light, lock, plug, EV charger, signage,
 *   irrigation valve, pump                   → actuator
 *   energy/grid/flow meter, battery, shelf,
 *   weather station, traffic + all others    → sensor
 *   crop camera                              → camera
 *   drone, asset tracker                     → tracker
 *
 * The concrete role stays legible in the device NAME ('Smart Thermostat {n}')
 * and in `defaultTelemetryKeys`; only the coarse enum is generic.
 *
 * ── Categories ────────────────────────────────────────────────────────────────
 * NOTE: the 8 templates DO still rely on 5 category values that are not in the
 * original `solution_templates_category_enum` (smart_agriculture, smart_energy,
 * smart_retail, smart_water, smart_facility). Seeding a database that has not
 * run 1785196800000-SolutionTemplateEnumExpansion will fail on those.
 */
@Injectable()
export class SolutionTemplateSeeder implements ISeeder {
  private readonly logger = new Logger(SolutionTemplateSeeder.name);

  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly solutionTemplateRepository: Repository<SolutionTemplate>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting solution template seeding...');

    const solutionTemplates: Partial<SolutionTemplate>[] = [
      // ══════════════════════════════════════════════════════════════════════
      // 1. SMART HOME
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Home',
        description:
          'Complete smart home automation with lighting, climate, security, and energy management',
        category: SolutionTemplateCategory.SMART_HOME,
        icon: 'home',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Climate control',
          'Smart lighting',
          'Security monitoring',
          'Energy management',
        ],
        tags: ['smart-home', 'automation', 'security', 'energy'],
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Smart Thermostat {n}',
              type: DeviceType.CONTROLLER,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'setpoint', 'mode'],
            },
            {
              name: 'Smart Light {n}',
              type: DeviceType.ACTUATOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'brightness', 'color_temp'],
            },
            {
              name: 'Motion Sensor {n}',
              type: DeviceType.SENSOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['motion', 'lux'],
            },
            {
              name: 'Door/Window Sensor {n}',
              type: DeviceType.SENSOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['contact', 'tamper'],
            },
            {
              name: 'Smart Lock {n}',
              type: DeviceType.ACTUATOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['lock_state', 'battery'],
            },
            {
              name: 'Smart Plug {n}',
              type: DeviceType.ACTUATOR,
              count: 6,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'power', 'energy'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Home Overview',
              description: 'Climate, security and energy at a glance',
              widgets: [
                { type: 'gauge', title: 'Living Room Temp', row: 0, col: 0, width: 3, height: 3 },
                { type: 'status-widget', title: 'Security Status', row: 0, col: 3, width: 3, height: 3 },
                { type: 'timeseries', title: 'Energy Consumption', row: 3, col: 0, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Active Alerts', row: 7, col: 0, width: 6, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Security Rules',
              description: 'Raises a security alert on motion detection',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Motion Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'motion', operator: 'EQUALS', value: true }],
                  },
                },
                {
                  name: 'Security Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Motion Detected',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Motion Detected',
              deviceSelector: 'all',
              telemetryKey: 'motion',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Door Opened',
              deviceSelector: 'all',
              telemetryKey: 'contact',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.INFO,
            },
            {
              name: 'Low Battery',
              deviceSelector: 'all',
              telemetryKey: 'battery',
              condition: AlarmCondition.LESS_THAN,
              value: 20,
              severity: AlarmSeverity.WARNING,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 2. SMART BUILDING
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Building',
        description:
          'Enterprise building management with HVAC, access control, energy monitoring, and occupancy tracking',
        category: SolutionTemplateCategory.SMART_BUILDING,
        icon: 'building',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'HVAC control',
          'Access control',
          'Energy monitoring',
          'Occupancy tracking',
          'Air quality monitoring',
        ],
        tags: ['smart-building', 'hvac', 'access-control', 'occupancy'],
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'HVAC Controller {n}',
              type: DeviceType.CONTROLLER,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'setpoint', 'mode', 'fan_speed'],
            },
            {
              name: 'Access Control {n}',
              type: DeviceType.CONTROLLER,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['door_state', 'last_access', 'access_granted'],
            },
            {
              name: 'Occupancy Sensor {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['occupancy', 'people_count', 'lux'],
            },
            {
              name: 'Energy Meter {n}',
              type: DeviceType.SENSOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['power', 'energy', 'voltage', 'current', 'power_factor'],
            },
            {
              name: 'Air Quality Sensor {n}',
              type: DeviceType.SENSOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['co2', 'tvoc', 'pm25', 'temperature', 'humidity'],
            },
            {
              name: 'Elevator Controller {n}',
              type: DeviceType.CONTROLLER,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['floor', 'state', 'door_state', 'load'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Building Overview',
              description: 'Energy, occupancy and access at a glance',
              widgets: [
                { type: 'timeseries', title: 'Energy Consumption', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Avg Temperature', row: 0, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Occupancy Trend', row: 4, col: 0, width: 6, height: 4 },
                { type: 'status-widget', title: 'Access Events', row: 4, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Building Alerts', row: 8, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Building Automation',
              description: 'Raises an alert when CO2 exceeds the comfort threshold',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'High CO2 Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'co2', operator: 'GREATER_THAN', value: 1000 }],
                  },
                },
                {
                  name: 'CO2 Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'High CO2',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'High CO2 Level',
              deviceSelector: 'all',
              telemetryKey: 'co2',
              condition: AlarmCondition.GREATER_THAN,
              value: 1000,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'High Energy Usage',
              deviceSelector: 'all',
              telemetryKey: 'power',
              condition: AlarmCondition.GREATER_THAN,
              value: 10000,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Unauthorized Access',
              deviceSelector: 'all',
              telemetryKey: 'access_granted',
              condition: AlarmCondition.EQUAL,
              value: 0,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 3. SMART CITY
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart City',
        description:
          'City-wide infrastructure monitoring including street lighting, waste management, traffic, and environmental sensors',
        category: SolutionTemplateCategory.SMART_CITY,
        icon: 'city',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Street lighting control',
          'Waste management',
          'Traffic monitoring',
          'Environmental sensing',
          'Smart parking',
        ],
        tags: ['smart-city', 'infrastructure', 'traffic', 'environment'],
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Street Light Controller {n}',
              type: DeviceType.CONTROLLER,
              count: 50,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'brightness', 'power', 'fault'],
            },
            {
              name: 'Waste Bin Sensor {n}',
              type: DeviceType.SENSOR,
              count: 30,
              protocol: DeviceProtocol.COAP,
              defaultTelemetryKeys: ['fill_level', 'temperature', 'tilt'],
            },
            {
              name: 'Traffic Sensor {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['vehicle_count', 'avg_speed', 'occupancy'],
            },
            {
              name: 'Environmental Sensor {n}',
              type: DeviceType.SENSOR,
              count: 15,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['aqi', 'pm25', 'pm10', 'no2', 'co', 'temperature', 'humidity'],
            },
            {
              name: 'Parking Sensor {n}',
              type: DeviceType.SENSOR,
              count: 100,
              protocol: DeviceProtocol.COAP,
              defaultTelemetryKeys: ['occupied', 'vehicle_detected'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - City Dashboard',
              description: 'City-wide asset, air quality and traffic overview',
              widgets: [
                { type: 'map', title: 'City Asset Map', row: 0, col: 0, width: 12, height: 6 },
                { type: 'timeseries', title: 'Air Quality Index', row: 6, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Avg Fill Level', row: 6, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Traffic Flow', row: 10, col: 0, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'City Alerts', row: 10, col: 6, width: 6, height: 4 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - City Alerts',
              description: 'Flags waste bins that need collection',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Full Bin Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'fill_level', operator: 'GREATER_THAN', value: 80 }],
                  },
                },
                {
                  name: 'Collection Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Bin Full',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Waste Bin Full',
              deviceSelector: 'all',
              telemetryKey: 'fill_level',
              condition: AlarmCondition.GREATER_THAN,
              value: 80,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Poor Air Quality',
              deviceSelector: 'all',
              telemetryKey: 'aqi',
              condition: AlarmCondition.GREATER_THAN,
              value: 150,
              severity: AlarmSeverity.ERROR,
            },
            {
              name: 'Street Light Fault',
              deviceSelector: 'all',
              telemetryKey: 'fault',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.ERROR,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 4. SMART AGRICULTURE
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Agriculture',
        description:
          'Precision farming with soil monitoring, weather stations, irrigation control, and crop health tracking',
        category: SolutionTemplateCategory.SMART_AGRICULTURE,
        icon: 'plant',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Soil monitoring',
          'Weather stations',
          'Automated irrigation',
          'Crop health tracking',
          'Drone surveying',
        ],
        tags: ['agriculture', 'farming', 'irrigation', 'precision-farming'],
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Soil Sensor {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'soil_moisture',
                'soil_temperature',
                'soil_ph',
                'soil_ec',
                'soil_nitrogen',
              ],
            },
            {
              name: 'Weather Station {n}',
              type: DeviceType.SENSOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'temperature',
                'humidity',
                'rainfall',
                'wind_speed',
                'wind_direction',
                'solar_radiation',
              ],
            },
            {
              name: 'Irrigation Controller {n}',
              type: DeviceType.ACTUATOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['valve_state', 'flow_rate', 'pressure', 'total_volume'],
            },
            {
              name: 'Crop Camera {n}',
              type: DeviceType.CAMERA,
              count: 5,
              protocol: DeviceProtocol.HTTP,
              defaultTelemetryKeys: ['image_url', 'health_index', 'pest_detected'],
            },
            {
              name: 'Drone Station {n}',
              type: DeviceType.TRACKER,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['battery', 'latitude', 'longitude', 'altitude', 'status'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Farm Overview',
              description: 'Field map, soil conditions and weather history',
              widgets: [
                { type: 'map', title: 'Field Map', row: 0, col: 0, width: 8, height: 5 },
                { type: 'gauge', title: 'Avg Soil Moisture', row: 0, col: 8, width: 4, height: 5 },
                { type: 'timeseries', title: 'Soil Conditions', row: 5, col: 0, width: 6, height: 4 },
                { type: 'timeseries', title: 'Weather History', row: 5, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Farm Alerts', row: 9, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Irrigation Automation',
              description: 'Raises an alarm when soil moisture drops below threshold',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Dry Soil Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'soil_moisture', operator: 'LESS_THAN', value: 30 }],
                  },
                },
                {
                  name: 'Irrigation Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Low Soil Moisture',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Low Soil Moisture',
              deviceSelector: 'all',
              telemetryKey: 'soil_moisture',
              condition: AlarmCondition.LESS_THAN,
              value: 25,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'High Soil Temperature',
              deviceSelector: 'all',
              telemetryKey: 'soil_temperature',
              condition: AlarmCondition.GREATER_THAN,
              value: 40,
              severity: AlarmSeverity.ERROR,
            },
            {
              name: 'Pest Detected',
              deviceSelector: 'all',
              telemetryKey: 'pest_detected',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 5. SMART ENERGY
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Energy',
        description:
          'Energy management with solar monitoring, grid analytics, battery storage, and consumption optimization',
        category: SolutionTemplateCategory.SMART_ENERGY,
        icon: 'battery',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Solar generation monitoring',
          'Battery storage management',
          'Grid import/export analytics',
          'EV charging',
          'Consumption optimization',
        ],
        tags: ['energy', 'solar', 'battery', 'grid', 'ev'],
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Solar Inverter {n}',
              type: DeviceType.CONTROLLER,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'dc_power',
                'ac_power',
                'efficiency',
                'temperature',
                'daily_energy',
                'total_energy',
              ],
            },
            {
              name: 'Energy Meter {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'power',
                'energy',
                'voltage',
                'current',
                'frequency',
                'power_factor',
              ],
            },
            {
              name: 'Battery Storage {n}',
              type: DeviceType.SENSOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['soc', 'voltage', 'current', 'temperature', 'state', 'cycles'],
            },
            {
              name: 'EV Charger {n}',
              type: DeviceType.ACTUATOR,
              count: 4,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'power', 'energy_delivered', 'session_duration'],
            },
            {
              name: 'Grid Meter {n}',
              type: DeviceType.SENSOR,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'import_power',
                'export_power',
                'import_energy',
                'export_energy',
              ],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Energy Dashboard',
              description: 'Generation, storage, grid flow and consumption',
              widgets: [
                { type: 'timeseries', title: 'Solar Generation', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Battery State of Charge', row: 0, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Grid Import/Export', row: 4, col: 0, width: 6, height: 4 },
                { type: 'timeseries', title: 'Energy Consumption', row: 4, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Energy Alerts', row: 8, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Energy Alerts',
              description: 'Raises an alarm when battery state of charge runs low',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Low Battery Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'soc', operator: 'LESS_THAN', value: 20 }],
                  },
                },
                {
                  name: 'Battery Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Low Battery',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Low Battery Storage',
              deviceSelector: 'all',
              telemetryKey: 'soc',
              condition: AlarmCondition.LESS_THAN,
              value: 20,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Inverter Fault',
              deviceSelector: 'all',
              telemetryKey: 'efficiency',
              condition: AlarmCondition.LESS_THAN,
              value: 70,
              severity: AlarmSeverity.ERROR,
            },
            {
              name: 'Grid Outage',
              deviceSelector: 'all',
              telemetryKey: 'import_power',
              condition: AlarmCondition.EQUAL,
              value: 0,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 6. SMART RETAIL SHOP
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Retail Shop',
        description:
          'Retail store management with customer counting, queue management, inventory tracking, and energy optimization',
        category: SolutionTemplateCategory.SMART_RETAIL,
        icon: 'shopping-cart',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Customer counting',
          'Queue management',
          'Inventory tracking',
          'Refrigeration monitoring',
          'Digital signage',
        ],
        tags: ['retail', 'shop', 'inventory', 'footfall'],
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'People Counter {n}',
              type: DeviceType.SENSOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['in_count', 'out_count', 'current_occupancy'],
            },
            {
              name: 'Queue Sensor {n}',
              type: DeviceType.SENSOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['queue_length', 'wait_time', 'service_time'],
            },
            {
              name: 'Refrigeration Monitor {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'door_state', 'compressor_state'],
            },
            {
              name: 'POS Terminal {n}',
              type: DeviceType.CONTROLLER,
              count: 6,
              protocol: DeviceProtocol.HTTP,
              defaultTelemetryKeys: ['transaction_count', 'revenue', 'avg_basket', 'status'],
            },
            {
              name: 'Digital Signage {n}',
              type: DeviceType.ACTUATOR,
              count: 4,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'content_id', 'brightness'],
            },
            {
              name: 'Smart Shelf {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['weight', 'item_count', 'low_stock'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Retail Overview',
              description: 'Footfall, queues and sales performance',
              widgets: [
                { type: 'gauge', title: 'Current Occupancy', row: 0, col: 0, width: 3, height: 3 },
                { type: 'gauge', title: 'Avg Queue Length', row: 0, col: 3, width: 3, height: 3 },
                { type: 'timeseries', title: 'Customer Traffic', row: 3, col: 0, width: 6, height: 4 },
                { type: 'timeseries', title: 'Sales Performance', row: 3, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Store Alerts', row: 7, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Retail Automation',
              description: 'Raises a restock alert when a shelf reports low stock',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Low Stock Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'low_stock', operator: 'EQUALS', value: 1 }],
                  },
                },
                {
                  name: 'Restock Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Low Stock',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Low Stock Alert',
              deviceSelector: 'all',
              telemetryKey: 'low_stock',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Refrigeration Temperature High',
              deviceSelector: 'all',
              telemetryKey: 'temperature',
              condition: AlarmCondition.GREATER_THAN,
              value: 8,
              severity: AlarmSeverity.CRITICAL,
            },
            {
              name: 'Long Queue Wait',
              deviceSelector: 'all',
              telemetryKey: 'wait_time',
              condition: AlarmCondition.GREATER_THAN,
              value: 10,
              severity: AlarmSeverity.WARNING,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 7. SMART WATER MANAGEMENT
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Water Management',
        description:
          'Water network monitoring with leak detection, quality analysis, pressure management, and consumption tracking',
        category: SolutionTemplateCategory.SMART_WATER,
        icon: 'droplet',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Leak detection',
          'Water quality analysis',
          'Pressure management',
          'Consumption tracking',
          'Tank level monitoring',
        ],
        tags: ['water', 'leak-detection', 'quality', 'network'],
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Flow Meter {n}',
              type: DeviceType.SENSOR,
              count: 15,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['flow_rate', 'total_volume', 'velocity', 'temperature'],
            },
            {
              name: 'Pressure Sensor {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['pressure', 'min_pressure', 'max_pressure'],
            },
            {
              name: 'Water Quality Sensor {n}',
              type: DeviceType.SENSOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'ph',
                'turbidity',
                'tds',
                'chlorine',
                'temperature',
                'conductivity',
              ],
            },
            {
              name: 'Leak Detector {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['leak_detected', 'moisture', 'acoustic_signal'],
            },
            {
              name: 'Pump Controller {n}',
              type: DeviceType.ACTUATOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['state', 'speed', 'power', 'flow_rate', 'pressure'],
            },
            {
              name: 'Tank Level Sensor {n}',
              type: DeviceType.SENSOR,
              count: 6,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['level', 'volume', 'percentage', 'temperature'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Water Network',
              description: 'Network map, pressure, flow and quality',
              widgets: [
                { type: 'map', title: 'Network Map', row: 0, col: 0, width: 8, height: 5 },
                { type: 'gauge', title: 'Network Pressure', row: 0, col: 8, width: 4, height: 5 },
                { type: 'timeseries', title: 'Flow Rate Trend', row: 5, col: 0, width: 6, height: 4 },
                { type: 'timeseries', title: 'Water Quality', row: 5, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Network Alerts', row: 9, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Leak Detection',
              description: 'Escalates a detected leak to a critical alarm',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Leak Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'leak_detected', operator: 'EQUALS', value: 1 }],
                  },
                },
                {
                  name: 'Leak Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Water Leak',
                    severity: AlarmSeverity.CRITICAL,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Water Leak Detected',
              deviceSelector: 'all',
              telemetryKey: 'leak_detected',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.CRITICAL,
            },
            {
              name: 'Low Pressure',
              deviceSelector: 'all',
              telemetryKey: 'pressure',
              condition: AlarmCondition.LESS_THAN,
              value: 2,
              severity: AlarmSeverity.ERROR,
            },
            {
              name: 'Poor Water Quality',
              deviceSelector: 'all',
              telemetryKey: 'turbidity',
              condition: AlarmCondition.GREATER_THAN,
              value: 4,
              severity: AlarmSeverity.ERROR,
            },
            {
              name: 'Low Tank Level',
              deviceSelector: 'all',
              telemetryKey: 'percentage',
              condition: AlarmCondition.LESS_THAN,
              value: 20,
              severity: AlarmSeverity.WARNING,
            },
          ],
        } satisfies TemplateConfiguration,
      },

      // ══════════════════════════════════════════════════════════════════════
      // 8. SMART FACILITY
      // ══════════════════════════════════════════════════════════════════════
      {
        name: 'Smart Facility',
        description:
          'Facility management with maintenance tracking, asset monitoring, cleaning management, and visitor management',
        category: SolutionTemplateCategory.SMART_FACILITY,
        icon: 'tools',
        author: 'Smart Life Platform',
        version: '1.0.0',
        features: [
          'Asset tracking',
          'Predictive maintenance',
          'Cleaning management',
          'Visitor management',
          'Environment monitoring',
        ],
        tags: ['facility', 'maintenance', 'assets', 'cleaning'],
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: 'Asset Tracker {n}',
              type: DeviceType.TRACKER,
              count: 30,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['latitude', 'longitude', 'battery', 'moving', 'last_seen'],
            },
            {
              name: 'Restroom Sensor {n}',
              type: DeviceType.SENSOR,
              count: 15,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'occupancy',
                'paper_level',
                'soap_level',
                'odor_level',
                'cleaning_needed',
              ],
            },
            {
              name: 'Maintenance Beacon {n}',
              type: DeviceType.SENSOR,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['vibration', 'temperature', 'noise_level', 'fault_code'],
            },
            {
              name: 'Visitor Counter {n}',
              type: DeviceType.SENSOR,
              count: 8,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['in_count', 'out_count', 'current_count'],
            },
            {
              name: 'Environment Sensor {n}',
              type: DeviceType.SENSOR,
              count: 12,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'co2', 'noise', 'lux'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Facility Overview',
              description: 'Occupancy, restroom status, environment and assets',
              widgets: [
                { type: 'gauge', title: 'Occupancy', row: 0, col: 0, width: 3, height: 3 },
                { type: 'status-widget', title: 'Restroom Status', row: 0, col: 3, width: 3, height: 3 },
                { type: 'timeseries', title: 'Environment Conditions', row: 3, col: 0, width: 6, height: 4 },
                { type: 'timeseries', title: 'Asset Activity', row: 3, col: 6, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Facility Alerts', row: 7, col: 0, width: 12, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Facility Maintenance',
              description: 'Raises a cleaning ticket when a restroom reports it is needed',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Cleaning Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [{ key: 'cleaning_needed', operator: 'EQUALS', value: 1 }],
                  },
                },
                {
                  name: 'Cleaning Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Cleaning Required',
                    severity: AlarmSeverity.INFO,
                  },
                },
              ],
              connections: [{ fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' }],
            },
          ],
          alarms: [
            {
              name: 'Cleaning Required',
              deviceSelector: 'all',
              telemetryKey: 'cleaning_needed',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.INFO,
            },
            {
              name: 'Asset Out of Zone',
              deviceSelector: 'all',
              telemetryKey: 'moving',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Equipment Fault',
              deviceSelector: 'all',
              telemetryKey: 'fault_code',
              condition: AlarmCondition.GREATER_THAN,
              value: 0,
              severity: AlarmSeverity.ERROR,
            },
          ],
        } satisfies TemplateConfiguration,
      },
    ];

    // ── Derive the summary counters from the provisioning spec ────────────────
    //
    // `devices` / `dashboards` / `rules` are display columns. Deriving them from
    // `configuration` keeps the catalogue honest: they can never disagree with
    // what install() actually provisions.
    //
    // `rules` counts every automation artefact: rule chains + alarm specs.
    for (const templateData of solutionTemplates) {
      const config = templateData.configuration;
      if (!config) continue;

      templateData.devices = (config.devices ?? []).reduce(
        (sum, d) => sum + (d.count ?? 0),
        0,
      );
      templateData.dashboards = (config.dashboards ?? []).length;
      templateData.rules =
        (config.ruleChains ?? []).length + (config.alarms ?? []).length;
    }

    // ── Upsert by name ────────────────────────────────────────────────────────
    let createdCount = 0;
    let refreshedCount = 0;

    for (const templateData of solutionTemplates) {
      const existing = await this.solutionTemplateRepository.findOne({
        where: { name: templateData.name },
        withDeleted: true, // revive a previously pruned template rather than colliding
      });

      if (!existing) {
        const template = this.solutionTemplateRepository.create({
          ...templateData,
          tenantId: undefined, // system templates belong to no tenant
          userId: undefined,
          rating: 0,
          ratings: {},
          ratingCount: 0,
          installs: 0,
        });
        await this.solutionTemplateRepository.save(template);
        this.logger.log(
          `✅ Created system template: ${templateData.name!.padEnd(24)} | ${templateData.devices} devices, ${templateData.dashboards} dashboards, ${templateData.rules} rules`,
        );
        createdCount++;
        continue;
      }

      // Refresh code-owned fields. Runtime state — rating / ratings /
      // ratingCount / installs — is deliberately preserved: it is earned by real
      // users and a re-seed must not clobber it.
      existing.deletedAt = undefined; // un-prune if it was soft-deleted earlier
      existing.description = templateData.description!;
      existing.category = templateData.category!;
      existing.icon = templateData.icon!;
      existing.author = templateData.author!;
      existing.version = templateData.version!;
      existing.features = templateData.features!;
      existing.tags = templateData.tags!;
      existing.devices = templateData.devices!;
      existing.dashboards = templateData.dashboards!;
      existing.rules = templateData.rules!;
      existing.isPremium = templateData.isPremium!;
      existing.isSystem = true;
      existing.tenantId = undefined;
      existing.configuration = templateData.configuration;
      existing.lastUpdated = new Date();
      await this.solutionTemplateRepository.save(existing);
      this.logger.log(
        `♻️  Refreshed system template: ${templateData.name!.padEnd(24)} | ${templateData.devices} devices, ${templateData.dashboards} dashboards, ${templateData.rules} rules`,
      );
      refreshedCount++;
    }

    const prunedCount = await this.pruneStaleSystemTemplates(
      solutionTemplates.map((t) => t.name!),
    );

    this.logger.log(
      `🎉 Solution template seeding completed! Created: ${createdCount}, Refreshed: ${refreshedCount}, Pruned: ${prunedCount}`,
    );
  }

  /**
   * Soft-deletes system templates that are no longer part of the canonical list.
   *
   * Soft, not hard: `template_installations.templateId` is ON DELETE CASCADE, so
   * a hard delete would silently destroy the installation history of every
   * tenant that ever installed the retired template. User-created templates
   * (isSystem = false) are never touched.
   */
  private async pruneStaleSystemTemplates(keepNames: string[]): Promise<number> {
    const stale = await this.solutionTemplateRepository.find({
      where: { isSystem: true, name: Not(In(keepNames)), deletedAt: IsNull() },
    });

    if (!stale.length) return 0;

    await this.solutionTemplateRepository.softRemove(stale);
    for (const t of stale) {
      this.logger.log(`🗑️  Pruned retired system template: ${t.name}`);
    }
    return stale.length;
  }
}
