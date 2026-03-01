import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { TriggerType, ActionType, AutomationStatus } from '@common/enums/index.enum'
@Entity('automations')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
export class Automation extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP (Who created this automation?)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  name: string;  // "Turn on motor when hot"

  @Column({ type: 'text', nullable: true })
  description?: string;  // "Activates cooling motor when temp exceeds 30°C"

  @Column({ default: true })
  @Index()
  enabled: boolean;  // Can user turn automation on/off

  @Column({ type: 'enum', enum: AutomationStatus, default: AutomationStatus.INACTIVE })
  @Index()
  status: AutomationStatus;
  // ACTIVE = Currently running
  // INACTIVE = Disabled by user
  // ERROR = Something went wrong (e.g., device offline)

  // ══════════════════════════════════════════════════════════════════════════
  // TRIGGER (WHEN to run automation?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  trigger: {
    type: TriggerType;                 // What kind of trigger?
    deviceId?: string;                 // Which device to watch?
    telemetryKey?: string;             // Which telemetry key? (temperature, humidity)
    attributeKey?: string;             // Or attribute key?
    operator?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';
    value?: any;                       // Compare against what value?
    value2?: any;                      // For 'between' operator
    schedule?: string;                 // Cron expression for scheduled triggers
    debounce?: number;                 // Wait N seconds before triggering
  };
  // Example 1 - THRESHOLD Trigger (temperature-based):
  // trigger: {
  //   type: 'threshold',
  //   deviceId: 'temp-sensor-001',
  //   telemetryKey: 'temperature',
  //   operator: 'gte',                // Greater than or equal
  //   value: 30,
  //   debounce: 60                    // Wait 60 seconds before triggering
  // }
  // → Triggers when temperature >= 30°C for at least 60 seconds
  //
  // Example 2 - STATE Trigger (device status change):
  // trigger: {
  //   type: 'state',
  //   deviceId: 'door-sensor-001',
  //   attributeKey: 'doorOpen',
  //   operator: 'eq',
  //   value: true
  // }
  // → Triggers when door opens
  //
  // Example 3 - SCHEDULE Trigger (time-based):
  // trigger: {
  //   type: 'schedule',
  //   schedule: '0 8 * * *'            // Every day at 8 AM (cron format)
  // }
  //
  // Example 4 - BETWEEN Trigger:
  // trigger: {
  //   type: 'threshold',
  //   deviceId: 'temp-sensor-001',
  //   telemetryKey: 'temperature',
  //   operator: 'between',
  //   value: 20,                       // Min
  //   value2: 30                       // Max
  // }
  // → Triggers when temperature is between 20-30°C
  
  // ══════════════════════════════════════════════════════════════════════════
  // ACTION (WHAT to do when triggered?)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb' })
  action: {
    type: ActionType;                  // What kind of action?
    deviceId?: string;                 // Which device to control?
    command?: string;                  // What command to send?
    value?: any;                       // What value to set?
    message?: string;                  // For notifications
    recipients?: string[];             // Who to notify?
    webhookUrl?: string;               // For webhook actions
    webhookMethod?: 'GET' | 'POST' | 'PUT';
    webhookHeaders?: Record<string, string>;
    webhookBody?: Record<string, any>;
  };
  // Example 1 - CONTROL Action (turn on motor):
  // action: {
  //   type: 'control',
  //   deviceId: 'motor-001',
  //   command: 'setPower',
  //   value: true                      // Turn ON
  // }
  //
  // Example 2 - SET_VALUE Action (adjust thermostat):
  // action: {
  //   type: 'setValue',
  //   deviceId: 'thermostat-001',
  //   command: 'setTemperature',
  //   value: 22                        // Set to 22°C
  // }
  //
  // Example 3 - NOTIFICATION Action:
  // action: {
  //   type: 'notification',
  //   message: 'Temperature is too high! Current: {{temperature}}°C',
  //   recipients: ['user-123', 'user-456']
  // }
  //
  // Example 4 - WEBHOOK Action (call external API):
  // action: {
  //   type: 'webhook',
  //   webhookUrl: 'https://api.example.com/alert',
  //   webhookMethod: 'POST',
  //   webhookHeaders: { 'Content-Type': 'application/json' },
  //   webhookBody: {
  //     alert: 'high_temperature',
  //     deviceId: '{{deviceId}}',
  //     value: '{{temperature}}'
  //   }
  // }  

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'int', default: 0 })
  executionCount: number;  // How many times has this automation run?

  @Column({ type: 'timestamp', nullable: true })
  lastTriggered?: Date;  // When was it last triggered?

  @Column({ type: 'timestamp', nullable: true })
  lastExecuted?: Date;  // When was action last executed?

  @Column({ type: 'text', nullable: true })
  lastError?: string;  // Last error message (if status = ERROR)

  // ══════════════════════════════════════════════════════════════════════════
  // ADVANCED SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    cooldown?: number;                 // Wait N seconds between executions
    maxExecutionsPerDay?: number;      // Limit executions per day
    activeHours?: {                    // Only run during these hours
      start: string;                   // "08:00"
      end: string;                     // "18:00"
    };
    activeDays?: number[];             // [1,2,3,4,5] = Mon-Fri
    retryOnFailure?: boolean;
    maxRetries?: number;
  };
  // Example:
  // settings: {
  //   cooldown: 300,                   // Don't trigger again for 5 minutes
  //   maxExecutionsPerDay: 10,         // Max 10 times per day
  //   activeHours: {
  //     start: '08:00',
  //     end: '18:00'                   // Only run 8 AM - 6 PM
  //   },
  //   activeDays: [1, 2, 3, 4, 5],     // Only Mon-Fri (0=Sunday, 6=Saturday)
  //   retryOnFailure: true,
  //   maxRetries: 3
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['hvac', 'cooling', 'critical']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
  
  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if automation can execute right now
   */
  canExecute(): boolean {
    if (!this.enabled) return false;
    if (this.status === AutomationStatus.ERROR) return false;

    // Check cooldown
    if (this.settings?.cooldown && this.lastExecuted) {
      const cooldownMs = this.settings.cooldown * 1000;
      const elapsed = Date.now() - this.lastExecuted.getTime();
      if (elapsed < cooldownMs) return false;
    }

    // Check active hours
    if (this.settings?.activeHours) {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const currentTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      
      if (currentTime < this.settings.activeHours.start || currentTime > this.settings.activeHours.end) {
        return false;
      }
    }

    // Check active days
    if (this.settings?.activeDays) {
      const today = new Date().getDay();
      if (!this.settings.activeDays.includes(today)) return false;
    }

    return true;
  }

  /**
   * Record successful execution
   */
  recordExecution(): void {
    this.executionCount++;
    this.lastTriggered = new Date();
    this.lastExecuted = new Date();
    this.status = AutomationStatus.ACTIVE;
    this.lastError = undefined;
  }

  /**
   * Record failed execution
   */
  recordError(error: string): void {
    this.status = AutomationStatus.ERROR;
    this.lastError = error;
  }
}
