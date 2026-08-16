export enum NotificationType {
  ALARM = 'alarm',
  DEVICE = 'device',
  SYSTEM = 'system',
  USER = 'user',
  REPORT = 'report',
}

// Values are persisted in the PG enum `notifications_channel_enum`. Adding a
// member here needs a migration (`ALTER TYPE ... ADD VALUE`) — see
// NotificationWhatsappChannel.
export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  WEBHOOK = 'webhook',
  IN_APP = 'in_app',
  WHATSAPP = 'whatsapp',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  READ = 'read',
}
