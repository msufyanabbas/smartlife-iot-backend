import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum ScriptType {
  PROCESSING = 'processing',
  FILTER = 'filter',
  AGGREGATION = 'aggregation',
  VALIDATION = 'validation',
  TRANSFORMATION = 'transformation',
}

@Entity('scripts')
@Index(['userId', 'type'])
export class Script extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: 'javascript' })
  language: string;

  @Column({
    type: 'enum',
    enum: ScriptType,
  })
  type: ScriptType;

  @Column({ type: 'text' })
  code: string;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ default: 0 })
  lines: number;

  @Column({
    name: 'last_modified',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastModified: Date;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
