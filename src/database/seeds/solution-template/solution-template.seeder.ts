// src/database/seeds/solution-template/solution-template.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SolutionTemplateCategory,
  DeviceType,
  AlarmSeverity,
  AlarmCondition,
  NodeType,
} from '@common/enums/index.enum';
import { SolutionTemplate, User, Tenant } from '@modules/index.entities';
import { DeviceProtocol } from '@modules/devices/entities/device.entity';
import type { TemplateConfiguration } from '@modules/solution-templates/interfaces/template-configuration.interface';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SolutionTemplateSeeder implements ISeeder {
  private readonly logger = new Logger(SolutionTemplateSeeder.name);

  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly solutionTemplateRepository: Repository<SolutionTemplate>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting solution template seeding...');

    // Fetch users and tenants for associations
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 10 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️ No users or tenants found. Please seed them first.');
      return;
    }

    const solutionTemplates: Partial<SolutionTemplate>[] = [
      {
        name: 'Smart Factory Monitoring',
        description: 'Complete IoT solution for manufacturing floor monitoring with real-time machine health tracking, predictive maintenance, and production analytics.',
        category: SolutionTemplateCategory.SMART_FACTORY,
        icon: 'factory',
        previewImage: 'https://cdn.smartlife.sa/templates/factory.png',
        author: 'IoT Platform Team',
        rating: 4.8,
        installs: 1523,
        version: '2.1.0',
        features: [
          'Real-time machine monitoring',
          'Predictive maintenance alerts',
          'OEE tracking',
          'Energy consumption monitoring',
        ],
        tags: ['manufacturing', 'industry-4.0', 'oee'],
        devices: 50,
        dashboards: 5,
        rules: 12,
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: '{installName} - Machine Sensor {n}',
              type: DeviceType.SENSOR,
              count: 4,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['vibration', 'temperature', 'rpm'],
            },
            {
              name: '{installName} - Energy Meter {n}',
              type: DeviceType.SENSOR,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['power', 'voltage', 'current'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Factory Overview',
              description: 'Machine health, OEE and energy consumption',
              widgets: [
                { type: 'timeseries', title: 'Vibration Trend', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Machine Temperature', row: 0, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Power Draw', row: 4, col: 0, width: 6, height: 4 },
                { type: 'status-widget', title: 'Machine Status', row: 4, col: 6, width: 3, height: 4 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Predictive Maintenance',
              description: 'Raises an alarm when vibration exceeds the safe threshold',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Vibration Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [
                      { key: 'vibration', operator: 'GREATER_THAN', value: 7.5 },
                    ],
                  },
                },
                {
                  name: 'Raise Maintenance Alarm',
                  type: NodeType.ACTION,
                  position: { x: 340, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Excessive Vibration',
                    severity: AlarmSeverity.CRITICAL,
                  },
                },
              ],
              connections: [
                { fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' },
              ],
            },
          ],
          alarms: [
            {
              name: 'Machine Overheating',
              deviceSelector: 'all',
              telemetryKey: 'temperature',
              condition: AlarmCondition.GREATER_THAN,
              value: 80,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Smart Home Automation',
        description: 'Comprehensive home automation template with climate control, security monitoring, and energy management.',
        category: SolutionTemplateCategory.SMART_HOME,
        icon: 'home',
        previewImage: 'https://cdn.smartlife.sa/templates/home.png',
        author: 'IoT Platform Team',
        rating: 4.9,
        installs: 3456,
        version: '3.0.2',
        features: [
          'Climate control',
          'Security & surveillance',
          'Energy monitoring',
        ],
        tags: ['home-automation', 'smart-home', 'security'],
        devices: 25,
        dashboards: 3,
        rules: 15,
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: '{installName} - Thermostat {n}',
              type: DeviceType.CONTROLLER,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'setpoint'],
            },
            {
              name: '{installName} - Door Sensor {n}',
              type: DeviceType.SENSOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['contact', 'battery'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Home Hub',
              description: 'Climate, security and energy at a glance',
              widgets: [
                { type: 'gauge', title: 'Living Room Temperature', row: 0, col: 0, width: 3, height: 4 },
                { type: 'timeseries', title: 'Humidity Trend', row: 0, col: 3, width: 6, height: 4 },
                { type: 'status-widget', title: 'Door Status', row: 4, col: 0, width: 4, height: 3 },
              ],
            },
          ],
          alarms: [
            {
              name: 'Low Sensor Battery',
              deviceSelector: 'all',
              telemetryKey: 'battery',
              condition: AlarmCondition.LESS_THAN,
              value: 15,
              severity: AlarmSeverity.WARNING,
            },
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Building Management System',
        description: 'Enterprise building management with HVAC control, occupancy monitoring, and energy optimization.',
        category: SolutionTemplateCategory.SMART_BUILDING,
        icon: 'building',
        previewImage: 'https://cdn.smartlife.sa/templates/building.png',
        author: 'IoT Platform Team',
        rating: 4.7,
        installs: 892,
        version: '1.8.5',
        features: [
          'HVAC optimization',
          'Occupancy sensing',
          'Energy analytics',
        ],
        tags: ['building-management', 'hvac', 'energy'],
        devices: 75,
        dashboards: 7,
        rules: 20,
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: '{installName} - Temperature Sensor {n}',
              type: DeviceType.SENSOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity'],
            },
            {
              name: '{installName} - Motion Detector {n}',
              type: DeviceType.SENSOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['motion', 'occupancy'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Overview',
              description: 'Building monitoring overview dashboard',
              widgets: [
                { type: 'timeseries', title: 'Temperature Trend', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Current Temperature', row: 0, col: 6, width: 3, height: 4 },
                { type: 'status-widget', title: 'Motion Status', row: 4, col: 0, width: 4, height: 3 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Alerts',
              description: 'HVAC escalation when a floor runs hot',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Temperature Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [
                      { key: 'temperature', operator: 'GREATER_THAN', value: 30 },
                    ],
                  },
                },
                {
                  name: 'Send Alert',
                  type: NodeType.ACTION,
                  position: { x: 340, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'High Temperature',
                    severity: AlarmSeverity.CRITICAL,
                  },
                },
              ],
              connections: [
                { fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' },
              ],
            },
          ],
          alarms: [
            {
              name: 'High Temperature Alert',
              deviceSelector: 'all',
              telemetryKey: 'temperature',
              condition: AlarmCondition.GREATER_THAN,
              value: 35,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Precision Agriculture',
        description: 'Agricultural IoT solution with soil monitoring, irrigation automation, and crop health analytics.',
        category: SolutionTemplateCategory.AGRICULTURE,
        icon: 'agriculture',
        previewImage: 'https://cdn.smartlife.sa/templates/agriculture.png',
        author: 'IoT Platform Team',
        rating: 4.5,
        installs: 678,
        version: '2.3.1',
        features: [
          'Soil moisture monitoring',
          'Automated irrigation',
          'Crop health tracking',
        ],
        tags: ['agriculture', 'farming', 'irrigation'],
        devices: 40,
        dashboards: 4,
        rules: 18,
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [
            {
              name: '{installName} - Soil Sensor {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['soil_moisture', 'soil_temperature', 'soil_ph'],
            },
            {
              name: '{installName} - Weather Station {n}',
              type: DeviceType.SENSOR,
              count: 2,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'rainfall', 'wind_speed'],
            },
            {
              name: '{installName} - Irrigation Controller {n}',
              type: DeviceType.ACTUATOR,
              count: 4,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['valve_state', 'flow_rate'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Farm Overview',
              description: 'Precision agriculture monitoring dashboard',
              widgets: [
                { type: 'timeseries', title: 'Soil Moisture Trend', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Current Soil Moisture', row: 0, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Weather Conditions', row: 4, col: 0, width: 6, height: 4 },
                { type: 'status-widget', title: 'Irrigation Status', row: 4, col: 6, width: 3, height: 4 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Irrigation Control',
              description: 'Raises an alarm when soil moisture drops below the irrigation threshold',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Low Moisture Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [
                      { key: 'soil_moisture', operator: 'LESS_THAN', value: 30 },
                    ],
                  },
                },
                {
                  name: 'Trigger Irrigation',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Low Soil Moisture',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [
                { fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' },
              ],
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
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Healthcare Monitoring',
        description: 'Healthcare facility monitoring with patient tracking and equipment monitoring.',
        category: SolutionTemplateCategory.HEALTHCARE,
        icon: 'hospital',
        previewImage: 'https://cdn.smartlife.sa/templates/healthcare.png',
        author: 'IoT Platform Team',
        rating: 4.9,
        installs: 567,
        version: '2.0.0',
        features: [
          'Patient vital monitoring',
          'Equipment tracking',
          'Alert management',
        ],
        tags: ['healthcare', 'hospital', 'patient-monitoring'],
        devices: 60,
        dashboards: 6,
        rules: 25,
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              // NOTE: the brief specified type 'MEDICAL_SENSOR'. DeviceType has no
              // such member and `devices.type` is a Postgres enum column, so using
              // it would fail at insert. Mapped to the nearest existing member.
              name: '{installName} - Patient Monitor {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'heart_rate',
                'blood_pressure_sys',
                'blood_pressure_dia',
                'spo2',
                'temperature',
              ],
            },
            {
              name: '{installName} - Room Environment {n}',
              type: DeviceType.SENSOR,
              count: 5,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['temperature', 'humidity', 'air_quality'],
            },
            {
              name: '{installName} - Emergency Button {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['button_pressed'],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Patient Overview',
              description: 'Healthcare monitoring dashboard',
              widgets: [
                { type: 'timeseries', title: 'Heart Rate Trend', row: 0, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Current SpO2', row: 0, col: 6, width: 3, height: 4 },
                { type: 'timeseries', title: 'Blood Pressure', row: 4, col: 0, width: 6, height: 4 },
                { type: 'alarm-widget', title: 'Active Alerts', row: 4, col: 6, width: 6, height: 4 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Critical Alerts',
              description: 'Escalates out-of-range patient vitals to a critical alarm',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Critical Vitals Filter',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [
                      { key: 'heart_rate', operator: 'GREATER_THAN', value: 120 },
                    ],
                  },
                },
                {
                  name: 'Emergency Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Critical Vitals',
                    severity: AlarmSeverity.CRITICAL,
                  },
                },
              ],
              connections: [
                { fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' },
              ],
            },
          ],
          alarms: [
            {
              name: 'High Heart Rate',
              deviceSelector: 'all',
              telemetryKey: 'heart_rate',
              condition: AlarmCondition.GREATER_THAN,
              value: 120,
              severity: AlarmSeverity.CRITICAL,
            },
            {
              name: 'Low SpO2',
              deviceSelector: 'all',
              telemetryKey: 'spo2',
              condition: AlarmCondition.LESS_THAN,
              value: 90,
              severity: AlarmSeverity.CRITICAL,
            },
            {
              // Brief said condition 'EQUALS'; the enum member is EQUAL.
              name: 'Emergency Button Pressed',
              deviceSelector: 'all',
              telemetryKey: 'button_pressed',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.CRITICAL,
            },
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Fleet & Logistics Tracking',
        description: 'Complete fleet management solution with vehicle tracking and route optimization.',
        category: SolutionTemplateCategory.LOGISTICS,
        icon: 'truck',
        previewImage: 'https://cdn.smartlife.sa/templates/logistics.png',
        author: 'IoT Platform Team',
        rating: 4.6,
        installs: 945,
        version: '1.9.2',
        features: [
          'Real-time GPS tracking',
          'Route optimization',
          'Fuel monitoring',
        ],
        tags: ['logistics', 'fleet', 'tracking'],
        devices: 100,
        dashboards: 6,
        rules: 22,
        isPremium: true,
        isSystem: true,
        configuration: {
          devices: [
            {
              // Brief said 'GPS_TRACKER'; DeviceType.TRACKER is the existing member.
              name: '{installName} - Vehicle Tracker {n}',
              type: DeviceType.TRACKER,
              count: 20,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'latitude',
                'longitude',
                'speed',
                'fuel_level',
                'engine_status',
              ],
            },
            {
              name: '{installName} - Cargo Sensor {n}',
              type: DeviceType.SENSOR,
              count: 10,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: [
                'temperature',
                'humidity',
                'shock_detected',
                'door_open',
              ],
            },
          ],
          dashboards: [
            {
              name: '{installName} - Fleet Overview',
              description: 'Fleet and logistics tracking dashboard',
              widgets: [
                { type: 'map', title: 'Vehicle Locations', row: 0, col: 0, width: 12, height: 6 },
                { type: 'timeseries', title: 'Speed History', row: 6, col: 0, width: 6, height: 4 },
                { type: 'gauge', title: 'Average Fuel Level', row: 6, col: 6, width: 3, height: 4 },
                { type: 'alarm-widget', title: 'Active Alerts', row: 10, col: 0, width: 12, height: 4 },
              ],
            },
          ],
          ruleChains: [
            {
              name: '{installName} - Speed & Safety',
              description: 'Raises a warning when a vehicle exceeds the speed limit',
              messageTypes: ['TELEMETRY'],
              nodes: [
                {
                  name: 'Speed Check',
                  type: NodeType.FILTER,
                  position: { x: 100, y: 100 },
                  configuration: {
                    conditions: [
                      { key: 'speed', operator: 'GREATER_THAN', value: 120 },
                    ],
                  },
                },
                {
                  name: 'Speeding Alert',
                  type: NodeType.ACTION,
                  position: { x: 300, y: 100 },
                  configuration: {
                    actionType: 'create_alarm',
                    alarmType: 'Speeding',
                    severity: AlarmSeverity.WARNING,
                  },
                },
              ],
              connections: [
                { fromNodeIndex: 0, toNodeIndex: 1, connectionType: 'success' },
              ],
            },
          ],
          alarms: [
            {
              name: 'Speeding Alert',
              deviceSelector: 'all',
              telemetryKey: 'speed',
              condition: AlarmCondition.GREATER_THAN,
              value: 120,
              severity: AlarmSeverity.WARNING,
            },
            {
              name: 'Low Fuel',
              deviceSelector: 'all',
              telemetryKey: 'fuel_level',
              condition: AlarmCondition.LESS_THAN,
              value: 15,
              severity: AlarmSeverity.WARNING,
            },
            {
              // Brief said condition 'EQUALS'; the enum member is EQUAL.
              name: 'Cargo Door Open',
              deviceSelector: 'all',
              telemetryKey: 'door_open',
              condition: AlarmCondition.EQUAL,
              value: 1,
              severity: AlarmSeverity.INFO,
            },
          ],
        } satisfies TemplateConfiguration,
      },
      {
        name: 'Custom Manufacturing Template',
        description: 'User-created template for specialized manufacturing process monitoring.',
        category: SolutionTemplateCategory.SMART_FACTORY,
        icon: 'custom',
        previewImage: 'https://cdn.smartlife.sa/templates/custom.png',
        author: users[0].name,
        rating: 4.2,
        installs: 23,
        version: '1.0.0',
        features: [
          'Custom device integration',
          'Process monitoring',
        ],
        tags: ['custom', 'manufacturing'],
        devices: 20,
        dashboards: 2,
        rules: 8,
        isPremium: false,
        isSystem: false,
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        configuration: {
          devices: [
            {
              name: '{installName} - Custom Sensor {n}',
              type: DeviceType.SENSOR,
              count: 3,
              protocol: DeviceProtocol.GENERIC_MQTT,
              defaultTelemetryKeys: ['value'],
            },
          ],
        } satisfies TemplateConfiguration,
      },
    ];

    // ── Derive the summary counters from the provisioning spec ────────────────
    //
    // `devices` / `dashboards` / `rules` are display columns. They used to be
    // hand-written marketing numbers that disagreed with what install() actually
    // creates (e.g. "40 devices" against a spec that provisions 16). Deriving
    // them from `configuration` keeps the catalogue honest and prevents drift
    // whenever a spec is edited.
    //
    // `rules` counts every automation artefact the install provisions:
    // rule chains + alarms.
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

    let createdCount = 0;
    let skippedCount = 0;
    let refreshedCount = 0;

    for (const templateData of solutionTemplates) {
      if (!templateData.name) {
        this.logger.warn('⚠️ Skipping template entry with missing name.');
        continue;
      }

      const existing = await this.solutionTemplateRepository.findOne({
        where: { name: templateData.name },
      });

      if (!existing) {
        const template = this.solutionTemplateRepository.create(templateData);
        await this.solutionTemplateRepository.save(template);
        this.logger.log(
          `✅ Created solution template: ${templateData.name.padEnd(30)} | Category: ${templateData.category} | ${templateData.isSystem ? 'System' : 'User'}`,
        );
        createdCount++;
      } else if (existing.isSystem) {
        // System templates are code-owned: refresh the catalogue fields so an
        // already-seeded database picks up spec changes without a reset.
        // User-created templates are never touched.
        //
        // Runtime state — rating / ratings / ratingCount / installs, plus the
        // ownership columns — is deliberately NOT refreshed: those are earned by
        // real users and would be clobbered by a re-seed.
        existing.description = templateData.description!;
        existing.category = templateData.category!;
        existing.icon = templateData.icon!;
        existing.previewImage = templateData.previewImage;
        existing.author = templateData.author!;
        existing.version = templateData.version!;
        existing.features = templateData.features!;
        existing.tags = templateData.tags!;
        existing.devices = templateData.devices!;
        existing.dashboards = templateData.dashboards!;
        existing.rules = templateData.rules!;
        existing.isPremium = templateData.isPremium!;
        existing.configuration = templateData.configuration;
        existing.lastUpdated = new Date();
        await this.solutionTemplateRepository.save(existing);
        this.logger.log(
          `♻️  Refreshed system template: ${templateData.name.padEnd(30)} | ${templateData.devices} devices, ${templateData.dashboards} dashboards, ${templateData.rules} rules`,
        );
        refreshedCount++;
      } else {
        this.logger.log(`⏭️  Solution template already exists: ${templateData.name}`);
        skippedCount++;
      }
    }

    this.logger.log(`🎉 Solution template seeding completed! Created: ${createdCount}, Refreshed: ${refreshedCount}, Skipped: ${skippedCount}`);
  }
}
