import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum Language {
  EN = 'en',
  AR = 'ar',
  FR = 'fr',
  ES = 'es',
}

export enum Theme {
  LIGHT = 'light',
  DARK = 'dark',
  AUTO = 'auto',
}

export enum TimeFormat {
  TWELVE_HOUR = '12h',
  TWENTY_FOUR_HOUR = '24h',
}

export enum DateFormat {
  DD_MM_YYYY = 'DD/MM/YYYY',
  MM_DD_YYYY = 'MM/DD/YYYY',
  YYYY_MM_DD = 'YYYY-MM-DD',
}

@Entity('user_settings')
export class UserSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ==================== GENERAL SETTINGS ====================

  @Column({
    type: 'enum',
    enum: Language,
    default: Language.EN,
  })
  language: Language;

  @Column({
    type: 'enum',
    enum: Theme,
    default: Theme.LIGHT,
  })
  theme: Theme;

  @Column({ default: false })
  autoRefreshDashboard: boolean;

  @Column({ default: 30 })
  dashboardRefreshInterval: number; // in seconds

  @Column({ default: false })
  compactMode: boolean;

  // ==================== NOTIFICATION SETTINGS ====================

  @Column({ default: true })
  emailNotifications: boolean;

  @Column({ default: true })
  alarmNotifications: boolean;

  @Column({ default: true })
  deviceStatusNotifications: boolean;

  @Column({ default: false })
  weeklyReports: boolean;

  @Column({ default: false })
  pushNotifications: boolean; // For future mobile app

  // ==================== DISPLAY SETTINGS ====================

  @Column({
    type: 'enum',
    enum: TimeFormat,
    default: TimeFormat.TWELVE_HOUR,
  })
  timeFormat: TimeFormat;

  @Column({
    type: 'enum',
    enum: DateFormat,
    default: DateFormat.DD_MM_YYYY,
  })
  dateFormat: DateFormat;

  @Column({ default: 'Asia/Riyadh' })
  timezone: string;

  // ==================== ADVANCED SETTINGS ====================

  @Column({ type: 'jsonb', nullable: true })
  dashboardLayout?: Record<string, any>; // Store custom dashboard layouts

  @Column({ type: 'jsonb', nullable: true })
  widgetPreferences?: Record<string, any>; // Widget-specific settings

  @Column({ type: 'jsonb', nullable: true })
  customPreferences?: Record<string, any>; // Any additional custom settings

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}