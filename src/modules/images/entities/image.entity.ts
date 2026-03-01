// src/modules/images/entities/image.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';

@Entity('images')
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['mimeType'])
export class Image extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // UPLOADER INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;  // Who uploaded this image

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  uploadedBy?: string;  // Denormalized user name/email for quick reference

  // ══════════════════════════════════════════════════════════════════════════
  // FILE INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;  // "profile-pic-2024.jpg" (stored filename)

  @Column()
  originalName: string;  // "My Photo.jpg" (user's original filename)

  @Column()
  mimeType: string;  // "image/jpeg", "image/png"

  @Column({ type: 'bigint' })
  size: number;  // File size in bytes

  // ══════════════════════════════════════════════════════════════════════════
  // STORAGE LOCATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  url: string;  // "https://cdn.smartlife.sa/images/abc123.jpg"

  @Column()
  path: string;  // "tenants/tenant-123/images/abc123.jpg" (storage path)

  @Column({ nullable: true })
  storageProvider?: string;  // "s3", "azure", "local"

  @Column({ nullable: true })
  bucket?: string;  // S3 bucket name or storage container

  // ══════════════════════════════════════════════════════════════════════════
  // IMAGE METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  dimensions?: {
    width: number;
    height: number;
    aspectRatio?: number;  // width/height
  };
  // Example: { width: 1920, height: 1080, aspectRatio: 1.78 }

  // ══════════════════════════════════════════════════════════════════════════
  // THUMBNAILS & VARIANTS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  thumbnails?: {
    small?: { url: string; width: number; height: number };   // 150x150
    medium?: { url: string; width: number; height: number };  // 300x300
    large?: { url: string; width: number; height: number };   // 600x600
  };
  // Example:
  // thumbnails: {
  //   small: { url: 'https://.../thumb-small.jpg', width: 150, height: 150 },
  //   medium: { url: 'https://.../thumb-medium.jpg', width: 300, height: 300 },
  //   large: { url: 'https://.../thumb-large.jpg', width: 600, height: 600 }
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // ENTITY ASSOCIATION (What is this image for?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  entityType?: string;  // "user", "device", "asset", "dashboard", "floor_plan"

  @Column({ nullable: true })

  entityId?: string;  // ID of the associated entity

  @Column({ nullable: true })
  fieldName?: string;  // "profilePhoto", "logo", "thumbnail"

  // Example 1 - User profile photo:
  // entityType: 'user', entityId: 'user-123', fieldName: 'profilePhoto'
  //
  // Example 2 - Device image:
  // entityType: 'device', entityId: 'device-456', fieldName: 'image'
  //
  // Example 3 - Asset photo:
  // entityType: 'asset', entityId: 'asset-789', fieldName: 'photo'

  // ══════════════════════════════════════════════════════════════════════════
  // IMAGE PROPERTIES
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  alt?: string;  // Alt text for accessibility

  @Column({ nullable: true })
  title?: string;  // Image title

  @Column({ type: 'text', nullable: true })
  description?: string;  // Image description

  // ══════════════════════════════════════════════════════════════════════════
  // USAGE TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: false })
  isPublic: boolean;  // Is this image publicly accessible?

  @Column({ type: 'int', default: 0 })
  viewCount: number;  // How many times viewed

  @Column({ type: 'int', default: 0 })
  downloadCount: number;  // How many times downloaded

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ["profile", "avatar", "thumbnail"]

  @Column({ type: 'jsonb', nullable: true })
  exif?: Record<string, any>;  // EXIF data from camera
  // Example:
  // exif: {
  //   Make: 'Canon',
  //   Model: 'EOS 5D',
  //   DateTime: '2024:01:15 10:30:00',
  //   GPS: { Latitude: 24.7136, Longitude: 46.6753 }
  // }

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get file size in human-readable format
   */
  getFormattedSize(): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = this.size;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Check if image is large (> 5MB)
   */
  isLarge(): boolean {
    return this.size > 5 * 1024 * 1024;
  }

  /**
   * Get thumbnail URL by size
   */
  getThumbnailUrl(size: 'small' | 'medium' | 'large' = 'medium'): string {
    return this.thumbnails?.[size]?.url || this.url;
  }

  /**
   * Check if image is a photo (JPEG/PNG)
   */
  isPhoto(): boolean {
    return ['image/jpeg', 'image/jpg', 'image/png'].includes(this.mimeType);
  }

  /**
   * Check if image is a vector (SVG)
   */
  isVector(): boolean {
    return this.mimeType === 'image/svg+xml';
  }

  /**
   * Get aspect ratio
   */
  getAspectRatio(): number | null {
    if (!this.dimensions) return null;
    return this.dimensions.width / this.dimensions.height;
  }

  /**
   * Check if image is landscape
   */
  isLandscape(): boolean {
    const ratio = this.getAspectRatio();
    return ratio !== null && ratio > 1;
  }

  /**
   * Check if image is portrait
   */
  isPortrait(): boolean {
    const ratio = this.getAspectRatio();
    return ratio !== null && ratio < 1;
  }

  /**
   * Increment view count
   */
  recordView(): void {
    this.viewCount++;
  }

  /**
   * Increment download count
   */
  recordDownload(): void {
    this.downloadCount++;
  }

  /**
   * Get image dimensions as string
   */
  getDimensionsString(): string {
    if (!this.dimensions) return 'Unknown';
    return `${this.dimensions.width} × ${this.dimensions.height}`;
  }
}