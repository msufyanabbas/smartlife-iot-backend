// src/database/seeders/dashboard.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Dashboard, User, Device, Tenant, Customer } from '@modules/index.entities';
import { DashboardVisibility } from '@common/enums/index.enum';
import { WidgetConfig } from '@common/interfaces/index.interface';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class DashboardSeeder implements ISeeder {
  constructor(
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async seed(): Promise<void> {
    console.log('📊 Seeding dashboards...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get first user
    const user = await this.userRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    if (!user) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Get first customer
    const customer = await this.customerRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    // Get devices
    const devices = await this.deviceRepository.find({
      where: { tenantId: tenant.id },
      take: 5,
    });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    const generateWidgetId = (): string => {
      return 'widget-' + Math.random().toString(36).substring(2, 15);
    };

    const getRandomDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      return date;
    };

    const dashboardsData: Partial<Dashboard>[] = [
      // 1. Main Operations Dashboard
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Main Operations Dashboard',
        description: 'Primary dashboard for monitoring all systems',
        visibility: DashboardVisibility.SHARED,
        isDefault: true,
        isFavorite: true,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'timeseries',
            title: 'Temperature Trends',
            position: { x: 0, y: 0, w: 6, h: 4 },
            dataSource: {
              deviceIds: [devices[0]?.id, devices[1]?.id].filter(Boolean),
              telemetryKeys: ['temperature'],
              aggregation: 'avg',
              timeRange: '24h',
              refreshInterval: 60,
              useWebSocket: true,
            },
            visualization: {
              chartType: 'line',
              colors: ['#FF6384', '#36A2EB'],
              showLegend: true,
              showGrid: true,
              unit: '°C',
              decimals: 1,
              thresholds: [
                { value: 0, color: '#0000FF', label: 'Cold' },
                { value: 20, color: '#00FF00', label: 'Normal' },
                { value: 30, color: '#FF0000', label: 'Hot' },
              ],
            },
          },
          {
            id: generateWidgetId(),
            type: 'gauge',
            title: 'Current Humidity',
            position: { x: 6, y: 0, w: 3, h: 4 },
            dataSource: {
              deviceIds: [devices[0]?.id],
              telemetryKeys: ['humidity'],
              refreshInterval: 30,
              useWebSocket: true,
            },
            visualization: {
              colors: ['#4CAF50', '#FFC107', '#F44336'],
              unit: '%',
              decimals: 0,
              min: 0,
              max: 100,
            },
          },
          {
            id: generateWidgetId(),
            type: 'table',
            title: 'Device Status',
            position: { x: 0, y: 4, w: 9, h: 4 },
            dataSource: {
              deviceIds: devices.slice(0, 3).map(d => d.id),
              telemetryKeys: ['status', 'lastSeen', 'battery'],
              refreshInterval: 60,
            },
            visualization: {
              showLegend: false,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
          compactType: 'vertical',
          margin: [10, 10],
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 60,
          theme: 'light',
          timezone: 'Asia/Riyadh',
          timeFormat: '24h',
        },
        viewCount: 125,
        lastViewedAt: getRandomDate(0),
        tags: ['operations', 'main', 'overview'],
      },

      // 2. Energy Management Dashboard
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Energy Management',
        description: 'Monitor and optimize energy consumption',
        visibility: DashboardVisibility.SHARED,
        isFavorite: true,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'chart',
            title: 'Power Consumption',
            position: { x: 0, y: 0, w: 6, h: 4 },
            dataSource: {
              deviceIds: devices.slice(0, 3).map(d => d.id),
              telemetryKeys: ['power'],
              aggregation: 'sum',
              timeRange: '7d',
              refreshInterval: 300,
            },
            visualization: {
              chartType: 'area',
              colors: ['#9C27B0'],
              showLegend: false,
              showGrid: true,
              unit: 'kWh',
              decimals: 2,
            },
          },
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Total Energy Today',
            position: { x: 6, y: 0, w: 3, h: 2 },
            dataSource: {
              deviceIds: devices.slice(0, 3).map(d => d.id),
              telemetryKeys: ['energy'],
              aggregation: 'sum',
              timeRange: '24h',
              refreshInterval: 300,
            },
            visualization: {
              colors: ['#9C27B0'],
              unit: 'kWh',
              decimals: 2,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 60,
          compactType: 'vertical',
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 300,
          theme: 'light',
          timezone: 'Asia/Riyadh',
        },
        viewCount: 78,
        lastViewedAt: getRandomDate(1),
        tags: ['energy', 'cost', 'optimization'],
      },

      // 3. Environmental Monitoring
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Environmental Monitoring',
        description: 'Track temperature, humidity, and air quality',
        visibility: DashboardVisibility.PRIVATE,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'chart',
            title: 'CO2 Levels',
            position: { x: 0, y: 0, w: 6, h: 4 },
            dataSource: {
              deviceIds: [devices[1]?.id || devices[0]?.id],
              telemetryKeys: ['co2'],
              aggregation: 'avg',
              timeRange: '24h',
              refreshInterval: 60,
            },
            visualization: {
              chartType: 'line',
              colors: ['#795548'],
              showGrid: true,
              unit: 'ppm',
              decimals: 0,
              thresholds: [
                { value: 0, color: '#4CAF50', label: 'Good' },
                { value: 800, color: '#FFC107', label: 'Fair' },
                { value: 1000, color: '#F44336', label: 'Poor' },
              ],
            },
          },
          {
            id: generateWidgetId(),
            type: 'gauge',
            title: 'Air Quality Index',
            position: { x: 6, y: 0, w: 3, h: 4 },
            dataSource: {
              deviceIds: [devices[2]?.id || devices[0]?.id],
              telemetryKeys: ['aqi'],
              refreshInterval: 60,
            },
            visualization: {
              colors: ['#4CAF50', '#FFEB3B', '#FF9800', '#F44336'],
              decimals: 0,
              min: 0,
              max: 500,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 60,
          theme: 'auto',
          timezone: 'Asia/Riyadh',
        },
        viewCount: 42,
        lastViewedAt: getRandomDate(2),
        tags: ['environment', 'air-quality', 'climate'],
      },

      // 4. Security & Alerts
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Security & Alerts',
        description: 'Monitor alarms and security status',
        visibility: DashboardVisibility.SHARED,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Active Alarms',
            position: { x: 0, y: 0, w: 3, h: 3 },
            dataSource: {
              telemetryKeys: ['alarmCount'],
              refreshInterval: 30,
            },
            visualization: {
              colors: ['#F44336'],
              decimals: 0,
              thresholds: [
                { value: 0, color: '#4CAF50' },
                { value: 5, color: '#FFC107' },
                { value: 10, color: '#F44336' },
              ],
            },
          },
          {
            id: generateWidgetId(),
            type: 'table',
            title: 'Recent Alarms',
            position: { x: 3, y: 0, w: 9, h: 6 },
            dataSource: {
              telemetryKeys: ['alarms'],
              timeRange: '7d',
              refreshInterval: 30,
            },
            visualization: {
              showLegend: false,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 30,
          theme: 'dark',
          timezone: 'Asia/Riyadh',
        },
        viewCount: 95,
        lastViewedAt: getRandomDate(0),
        tags: ['security', 'alarms', 'monitoring'],
      },

      // 5. Device Map Dashboard
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Device Locations',
        description: 'Track device locations on map',
        visibility: DashboardVisibility.PRIVATE,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'map',
            title: 'Device Locations',
            position: { x: 0, y: 0, w: 12, h: 6 },
            dataSource: {
              deviceIds: devices.slice(0, 4).map(d => d.id),
              telemetryKeys: ['latitude', 'longitude'],
              refreshInterval: 120,
            },
            visualization: {
              colors: ['#2196F3'],
            },
          },
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Active Devices',
            position: { x: 0, y: 6, w: 3, h: 2 },
            dataSource: {
              telemetryKeys: ['activeDevices'],
              refreshInterval: 60,
            },
            visualization: {
              colors: ['#2196F3'],
              decimals: 0,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 30,
          theme: 'light',
          timezone: 'Asia/Riyadh',
        },
        viewCount: 34,
        lastViewedAt: getRandomDate(3),
        tags: ['map', 'location', 'gps'],
      },
    ];

    for (const dashboardData of dashboardsData) {
      const existing = await this.dashboardRepository.findOne({
        where: {
          name: dashboardData.name,
          tenantId: dashboardData.tenantId,
        },
      });

      if (!existing) {
        const dashboard = this.dashboardRepository.create(dashboardData);
        await this.dashboardRepository.save(dashboard);
        console.log(
          `✅ Created dashboard: ${dashboardData.name} (${dashboardData.widgets?.length ?? 0} widgets)`,
        );
      } else {
        console.log(
          `⏭️  Dashboard already exists: ${dashboardData.name}`,
        );
      }
    }

    console.log('🎉 Dashboard seeding completed! (5 dashboards created)');
  }
}