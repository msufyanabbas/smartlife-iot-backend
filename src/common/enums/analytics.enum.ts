export enum AnalyticsType {
  DEVICE_USAGE        = 'device_usage',
  TELEMETRY_STATS     = 'telemetry_stats',
  ALARM_FREQUENCY     = 'alarm_frequency',
  USER_ACTIVITY       = 'user_activity',
  SYSTEM_PERFORMANCE  = 'system_performance',
  DASHBOARD_PERFORMANCE = 'dashboard_performance',
  DATA_CONSUMPTION    = 'data_consumption',
  ENERGY_METRICS      = 'energy_metrics',
  GEO_DISTRIBUTION    = 'geo_distribution',
  SYSTEM_HEALTH       = 'system_health',
  WIDGET_PERFORMANCE  = 'widget_performance',
}

export enum AnalyticsPeriod {
  HOURLY  = 'hourly',
  DAILY   = 'daily',
  WEEKLY  = 'weekly',
  MONTHLY = 'monthly',
}