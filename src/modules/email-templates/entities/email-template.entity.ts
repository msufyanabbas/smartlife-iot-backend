import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum EmailTemplateType {
  VERIFICATION = 'verification',
  WELCOME = 'welcome',
  PASSWORD_RESET = 'password_reset',
  PASSWORD_CHANGED = 'password_changed',
  ACCOUNT_LOCKED = 'account_locked',
  TWO_FACTOR_CODE = 'two_factor_code',
  ALERT_NOTIFICATION = 'alert_notification',
  DEVICE_OFFLINE = 'device_offline',
  SUBSCRIPTION_EXPIRING = 'subscription_expiring',
  CUSTOM = 'custom',
}

@Entity('email_templates')
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: EmailTemplateType,
    unique: true,
  })
  type: EmailTemplateType;

  @Column()
  name: string;

  @Column()
  subject: string;

  @Column('text')
  htmlTemplate: string;

  @Column('text')
  textTemplate: string;

  @Column('jsonb', { nullable: true })
  variables: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  description: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
