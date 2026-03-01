// src/modules/email-templates/entities/email-template.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@modules/index.entities';
import { EmailTemplateType } from '@common/enums/index.enum';

@Entity('email_templates')
@Index(['tenantId', 'type'], { unique: true })  // One template per type per tenant
@Index(['tenantId', 'isActive'])
@Index(['type'])
export class EmailTemplate extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system templates)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  tenantId?: string;  // null = system template, non-null = tenant-specific override

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE TYPE & INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'enum', enum: EmailTemplateType })

  type: EmailTemplateType;

  @Column()
  name: string;  // "Email Verification", "Welcome Email"

  @Column({ type: 'text', nullable: true })
  description?: string;  // "Sent when user registers"

  @Column({ default: true })

  isActive: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // EMAIL CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  subject: string;  // "Verify your email - {{companyName}}"

  @Column({ type: 'text' })
  htmlTemplate: string;  // HTML version with {{variables}}

  @Column({ type: 'text' })
  textTemplate: string;  // Plain text version with {{variables}}

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE VARIABLES
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  variables?: {
    required?: string[];      // ['userName', 'verificationLink']
    optional?: string[];      // ['companyName', 'supportEmail']
    defaults?: Record<string, any>;  // { companyName: 'Smart Life' }
  };
  // Example:
  // variables: {
  //   required: ['userName', 'verificationLink'],
  //   optional: ['companyName', 'supportEmail'],
  //   defaults: {
  //     companyName: 'Smart Life',
  //     supportEmail: 'support@smartlife.sa'
  //   }
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // EMAIL SETTINGS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    fromName?: string;        // "Smart Life Support"
    fromEmail?: string;       // "noreply@smartlife.sa"
    replyTo?: string;         // "support@smartlife.sa"
    cc?: string[];
    bcc?: string[];
    priority?: 'high' | 'normal' | 'low';
    attachments?: Array<{
      filename: string;
      path: string;
    }>;
  };
  // Example:
  // settings: {
  //   fromName: 'Smart Life Support',
  //   fromEmail: 'noreply@smartlife.sa',
  //   replyTo: 'support@smartlife.sa',
  //   priority: 'high'
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // LOCALIZATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: 'en' })
  locale: string;  // 'en', 'ar', 'fr'

  @Column({ type: 'jsonb', nullable: true })
  translations?: Record<string, {
    subject: string;
    htmlTemplate: string;
    textTemplate: string;
  }>;
  // Example:
  // translations: {
  //   ar: {
  //     subject: 'تحقق من بريدك الإلكتروني',
  //     htmlTemplate: '<div dir="rtl">...</div>',
  //     textTemplate: '...'
  //   },
  //   fr: {
  //     subject: 'Vérifiez votre email',
  //     htmlTemplate: '<div>...</div>',
  //     textTemplate: '...'
  //   }
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // USAGE TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  usageCount: number;  // How many times this template was used

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['user-management', 'security', 'notifications']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if this is a system template (not tenant-specific)
   */
  isSystemTemplate(): boolean {
    return this.tenantId === null || this.tenantId === undefined;
  }

  /**
   * Render template with variables
   */
  render(variables: Record<string, any>, locale?: string): {
    subject: string;
    html: string;
    text: string;
  } {
    // Use translated version if available
    let subject = this.subject;
    let htmlTemplate = this.htmlTemplate;
    let textTemplate = this.textTemplate;

    if (locale && this.translations?.[locale]) {
      const translation = this.translations[locale];
      subject = translation.subject;
      htmlTemplate = translation.htmlTemplate;
      textTemplate = translation.textTemplate;
    }

    // Merge with defaults
    const allVariables = {
      ...this.variables?.defaults,
      ...variables,
    };

    // Replace variables in templates
    const replacer = (template: string): string => {
      return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return allVariables[key] ?? match;
      });
    };

    return {
      subject: replacer(subject),
      html: replacer(htmlTemplate),
      text: replacer(textTemplate),
    };
  }

  /**
   * Validate required variables
   */
  validateVariables(variables: Record<string, any>): {
    valid: boolean;
    missing: string[];
  } {
    const required = this.variables?.required ?? [];
    const missing = required.filter(key => !(key in variables));

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Increment usage count
   */
  recordUsage(): void {
    this.usageCount++;
    this.lastUsedAt = new Date();
  }

  /**
   * Get template for specific locale
   */
  getLocalized(locale: string): {
    subject: string;
    htmlTemplate: string;
    textTemplate: string;
  } {
    if (this.translations?.[locale]) {
      return this.translations[locale];
    }

    return {
      subject: this.subject,
      htmlTemplate: this.htmlTemplate,
      textTemplate: this.textTemplate,
    };
  }
}