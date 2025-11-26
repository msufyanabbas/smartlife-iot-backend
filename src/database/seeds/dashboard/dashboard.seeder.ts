import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Dashboard,
  DashboardVisibility,
  WidgetConfig,
} from '../../../modules/dashboards/entities/dashboard.entity';
import { User } from '../../../modules/users/entities/user.entity';
import { Device } from '../../../modules/devices/entities/device.entity';
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
  ) {}

  async seed(): Promise<void> {
    // Fetch entities
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 15 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const getRandomItems = <T>(array: T[], count: number): T[] => {
      const shuffled = [...array].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, Math.min(count, array.length));
    };

    const getRandomDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(
        Math.floor(Math.random() * 24),
        Math.floor(Math.random() * 60),
      );
      return date;
    };

    const generateWidgetId = (): string => {
      return 'widget-' + Math.random().toString(36).substring(2, 15);
    };

    // Widget Templates
    const createTemperatureWidget = (deviceIds: string[]): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'timeseries',
      title: 'Temperature Trends',
      position: { x: 0, y: 0, w: 6, h: 4 },
      dataSource: {
        deviceIds,
        telemetryKeys: ['temperature'],
        aggregation: 'avg',
        timeRange: '24h',
        refreshInterval: 60,
      },
      visualization: {
        chartType: 'line',
        colors: ['#FF6384', '#36A2EB', '#FFCE56'],
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
    });

    const createHumidityGauge = (deviceId: string): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'gauge',
      title: 'Current Humidity',
      position: { x: 6, y: 0, w: 3, h: 3 },
      dataSource: {
        deviceIds: [deviceId],
        telemetryKeys: ['humidity'],
        refreshInterval: 30,
      },
      visualization: {
        colors: ['#4CAF50', '#FFC107', '#F44336'],
        unit: '%',
        decimals: 0,
        thresholds: [
          { value: 0, color: '#F44336', label: 'Low' },
          { value: 40, color: '#4CAF50', label: 'Optimal' },
          { value: 70, color: '#FFC107', label: 'High' },
        ],
      },
    });

    const createPowerConsumptionChart = (
      deviceIds: string[],
    ): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'chart',
      title: 'Power Consumption',
      position: { x: 0, y: 4, w: 6, h: 4 },
      dataSource: {
        deviceIds,
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
    });

    const createDeviceStatusTable = (deviceIds: string[]): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'table',
      title: 'Device Status',
      position: { x: 6, y: 4, w: 6, h: 4 },
      dataSource: {
        deviceIds,
        telemetryKeys: ['status', 'lastSeen', 'battery'],
        refreshInterval: 60,
      },
      visualization: {
        showLegend: false,
      },
    });

    const createDeviceMapWidget = (deviceIds: string[]): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'map',
      title: 'Device Locations',
      position: { x: 0, y: 8, w: 12, h: 5 },
      dataSource: {
        deviceIds,
        telemetryKeys: ['latitude', 'longitude'],
        refreshInterval: 120,
      },
      visualization: {
        colors: ['#2196F3'],
      },
    });

    const createAlarmStatsWidget = (): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'stat',
      title: 'Active Alarms',
      position: { x: 9, y: 0, w: 3, h: 3 },
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
    });

    const createEnergyHeatmap = (deviceIds: string[]): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'heatmap',
      title: 'Energy Usage Heatmap',
      position: { x: 6, y: 8, w: 6, h: 5 },
      dataSource: {
        deviceIds,
        telemetryKeys: ['energy'],
        aggregation: 'sum',
        timeRange: '30d',
        refreshInterval: 600,
      },
      visualization: {
        colors: ['#FFEB3B', '#FF9800', '#F44336'],
        unit: 'kWh',
      },
    });

    const createConnectionStatsPie = (): WidgetConfig => ({
      id: generateWidgetId(),
      type: 'chart',
      title: 'Device Connection Status',
      position: { x: 9, y: 3, w: 3, h: 4 },
      dataSource: {
        telemetryKeys: ['connectionStatus'],
        refreshInterval: 60,
      },
      visualization: {
        chartType: 'doughnut',
        colors: ['#4CAF50', '#F44336', '#FFC107'],
        showLegend: true,
      },
    });

    // Create Dashboards
    const dashboards: Partial<Dashboard>[] = [
      // Main Operations Dashboard
      {
        name: 'Main Operations Dashboard',
        description: 'Primary dashboard for monitoring all systems',
        visibility: DashboardVisibility.SHARED,
        userId: users[0].id,
        widgets: [
          createTemperatureWidget(getRandomItems(devices, 3).map((d) => d.id)),
          createHumidityGauge(devices[0]?.id),
          createAlarmStatsWidget(),
          createPowerConsumptionChart(
            getRandomItems(devices, 5).map((d) => d.id),
          ),
          createDeviceStatusTable(getRandomItems(devices, 8).map((d) => d.id)),
          createDeviceMapWidget(getRandomItems(devices, 10).map((d) => d.id)),
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
          compactType: 'vertical',
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 60,
          theme: 'light',
          timezone: 'Asia/Riyadh',
        },
        isDefault: true,
        isFavorite: true,
        sharedWith: users.slice(1, 4).map((u) => u.id),
        viewCount: Math.floor(Math.random() * 500) + 100,
        lastViewedAt: getRandomDate(0),
        tags: ['operations', 'main', 'overview'],
      },

      // Energy Management Dashboard
      {
        name: 'Energy Management',
        description: 'Monitor and optimize energy consumption',
        visibility: DashboardVisibility.SHARED,
        userId: users[0].id,
        widgets: [
          createPowerConsumptionChart(
            getRandomItems(devices, 6).map((d) => d.id),
          ),
          createEnergyHeatmap(getRandomItems(devices, 8).map((d) => d.id)),
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Total Energy Today',
            position: { x: 0, y: 0, w: 3, h: 2 },
            dataSource: {
              deviceIds: devices.slice(0, 10).map((d) => d.id),
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
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Cost Estimate',
            position: { x: 3, y: 0, w: 3, h: 2 },
            dataSource: {
              telemetryKeys: ['cost'],
              refreshInterval: 300,
            },
            visualization: {
              colors: ['#4CAF50'],
              unit: 'SAR',
              decimals: 2,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 60,
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 300,
          theme: 'light',
        },
        isFavorite: true,
        viewCount: Math.floor(Math.random() * 300) + 50,
        lastViewedAt: getRandomDate(1),
        tags: ['energy', 'cost', 'optimization'],
      },

      // Environmental Monitoring
      {
        name: 'Environmental Monitoring',
        description: 'Track temperature, humidity, and air quality',
        visibility: DashboardVisibility.PRIVATE,
        userId: users[1]?.id || users[0].id,
        widgets: [
          createTemperatureWidget(getRandomItems(devices, 4).map((d) => d.id)),
          createHumidityGauge(devices[1]?.id || devices[0].id),
          {
            id: generateWidgetId(),
            type: 'chart',
            title: 'CO2 Levels',
            position: { x: 0, y: 4, w: 6, h: 4 },
            dataSource: {
              deviceIds: getRandomItems(devices, 3).map((d) => d.id),
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
            position: { x: 6, y: 4, w: 3, h: 4 },
            dataSource: {
              deviceIds: [devices[2]?.id || devices[0].id],
              telemetryKeys: ['aqi'],
              refreshInterval: 60,
            },
            visualization: {
              colors: ['#4CAF50', '#FFEB3B', '#FF9800', '#F44336'],
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
          refreshInterval: 60,
          theme: 'auto',
        },
        viewCount: Math.floor(Math.random() * 200) + 30,
        lastViewedAt: getRandomDate(2),
        tags: ['environment', 'air-quality', 'climate'],
      },

      // Security & Alerts
      {
        name: 'Security & Alerts',
        description: 'Monitor alarms and security status',
        visibility: DashboardVisibility.SHARED,
        userId: users[0].id,
        widgets: [
          createAlarmStatsWidget(),
          {
            id: generateWidgetId(),
            type: 'table',
            title: 'Recent Alarms',
            position: { x: 0, y: 0, w: 9, h: 6 },
            dataSource: {
              telemetryKeys: ['alarms'],
              timeRange: '7d',
              refreshInterval: 30,
            },
            visualization: {
              showLegend: false,
            },
          },
          createConnectionStatsPie(),
          {
            id: generateWidgetId(),
            type: 'timeseries',
            title: 'Alarm History',
            position: { x: 0, y: 6, w: 12, h: 4 },
            dataSource: {
              telemetryKeys: ['alarmCount'],
              aggregation: 'count',
              timeRange: '30d',
              refreshInterval: 300,
            },
            visualization: {
              chartType: 'bar',
              colors: ['#F44336', '#FF9800', '#FFC107'],
              showGrid: true,
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
        },
        sharedWith: users.slice(1, 3).map((u) => u.id),
        viewCount: Math.floor(Math.random() * 400) + 80,
        lastViewedAt: getRandomDate(0),
        tags: ['security', 'alarms', 'monitoring'],
      },

      // Fleet Management
      {
        name: 'Fleet Management',
        description: 'Track vehicle locations and status',
        visibility: DashboardVisibility.PRIVATE,
        userId: users[2]?.id || users[0].id,
        widgets: [
          createDeviceMapWidget(getRandomItems(devices, 5).map((d) => d.id)),
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Active Vehicles',
            position: { x: 0, y: 0, w: 3, h: 2 },
            dataSource: {
              telemetryKeys: ['activeVehicles'],
              refreshInterval: 60,
            },
            visualization: {
              colors: ['#2196F3'],
              decimals: 0,
            },
          },
          {
            id: generateWidgetId(),
            type: 'table',
            title: 'Vehicle Status',
            position: { x: 0, y: 5, w: 12, h: 4 },
            dataSource: {
              deviceIds: getRandomItems(devices, 6).map((d) => d.id),
              telemetryKeys: ['speed', 'fuel', 'odometer'],
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
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 30,
          theme: 'light',
        },
        viewCount: Math.floor(Math.random() * 150) + 20,
        lastViewedAt: getRandomDate(3),
        tags: ['fleet', 'vehicles', 'gps'],
      },

      // Personal Dashboard
      {
        name: 'My Personal Dashboard',
        description: 'Customized view of my devices',
        visibility: DashboardVisibility.PRIVATE,
        userId: users[3]?.id || users[0].id,
        widgets: [
          createTemperatureWidget(
            [devices[0]?.id, devices[1]?.id].filter(Boolean),
          ),
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'My Devices',
            position: { x: 6, y: 0, w: 3, h: 3 },
            dataSource: {
              telemetryKeys: ['deviceCount'],
              refreshInterval: 300,
            },
            visualization: {
              colors: ['#3F51B5'],
              decimals: 0,
            },
          },
        ],
        layout: {
          cols: 12,
          rowHeight: 60,
        },
        settings: {
          autoRefresh: false,
          theme: 'auto',
        },
        isFavorite: true,
        viewCount: Math.floor(Math.random() * 100) + 10,
        lastViewedAt: getRandomDate(1),
        tags: ['personal', 'custom'],
      },

      // Public Demo Dashboard
      {
        name: 'Public Demo Dashboard',
        description: 'Publicly accessible demo dashboard',
        visibility: DashboardVisibility.PUBLIC,
        userId: users[0].id,
        widgets: [
          {
            id: generateWidgetId(),
            type: 'stat',
            title: 'Total Devices',
            position: { x: 0, y: 0, w: 4, h: 2 },
            dataSource: {
              telemetryKeys: ['totalDevices'],
              refreshInterval: 300,
            },
            visualization: {
              colors: ['#00BCD4'],
              decimals: 0,
            },
          },
          createTemperatureWidget(devices.slice(0, 2).map((d) => d.id)),
          createConnectionStatsPie(),
        ],
        layout: {
          cols: 12,
          rowHeight: 50,
        },
        settings: {
          autoRefresh: true,
          refreshInterval: 120,
          theme: 'light',
        },
        viewCount: Math.floor(Math.random() * 1000) + 200,
        lastViewedAt: getRandomDate(0),
        tags: ['demo', 'public', 'showcase'],
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const dashboardData of dashboards) {
      const existing = await this.dashboardRepository.findOne({
        where: { name: dashboardData.name, userId: dashboardData.userId },
      });

      if (!existing) {
        const dashboard = this.dashboardRepository.create(dashboardData);
        await this.dashboardRepository.save(dashboard);
        console.log(
          `✅ Created dashboard: ${dashboardData.name} (${dashboardData.widgets?.length ?? 0} widgets)`,
        );

        created++;
      } else {
        console.log(`⏭️  Dashboard already exists: ${dashboardData.name}`);
        skipped++;
      }
    }

    console.log(`\n📊 Summary: ${created} created, ${skipped} skipped`);
    console.log('🎉 Dashboard seeding completed!');
  }
}
