import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('images')
// @Index(['userId'])
export class Image extends BaseEntity {
  @Column()
  name: string;

  @Column({ name: 'original_name' })
  originalName: string;

  @Column({ name: 'mime_type' })
  mimeType: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  url: string;

  @Column()
  path: string;

  @Column({ type: 'jsonb', nullable: true })
  dimensions?: {
    width: number;
    height: number;
  };

  @Column({ name: 'uploaded_by' })
  uploadedBy: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
