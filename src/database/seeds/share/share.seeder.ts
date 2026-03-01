// src/database/seeds/share/share.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ShareType,
  ShareResourceType,
  AccessLevel,
} from '@common/enums/index.enum';
import { Share, User, Tenant, Dashboard, Device, Asset } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class ShareSeeder implements ISeeder {
  private readonly logger = new Logger(ShareSeeder.name);

  constructor(
    @InjectRepository(Share)
    private readonly shareRepository: Repository<Share>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting share seeding with full field coverage...');

    // Check if shares already exist
    const existingShares = await this.shareRepository.count();
    if (existingShares > 0) {
      this.logger.log(`⏭️  Shares already seeded (${existingShares} records). Skipping...`);
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });
    const dashboards = await this.dashboardRepository.find({ take: 5 });
    const devices = await this.deviceRepository.find({ take: 5 });
    const assets = await this.assetRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    // Helper functions
    const generateToken = (): string => crypto.randomBytes(32).toString('hex');

    const generateExpiresAt = (daysFromNow: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return date;
    };

    const shares: Partial<Share>[] = [];

    // ════════════════════════════════════════════════════════════════
    // 1. DASHBOARD SHARES
    // ════════════════════════════════════════════════════════════════
    if (dashboards.length > 0 && users.length >= 2) {
      shares.push(
        {
          // Tenant scope
          tenantId: dashboards[0].tenantId,

          // Owner
          sharedBy: users[0].id,

          // Resource reference
          resourceType: ShareResourceType.DASHBOARD,
          resourceId: dashboards[0].id,

          // Share configuration
          shareType: ShareType.EMAIL,
          accessLevel: AccessLevel.VIEW,

          // Recipient
          sharedWith: users[1]?.email || 'colleague@smartlife.sa',

          // Link sharing
          isPublic: false,
          expiresAt: generateExpiresAt(30),

          // Statistics
          views: 15,
          lastViewedAt: new Date(Date.now() - 3600000), // 1 hour ago

          // Metadata
          metadata: {
            resourceName: dashboards[0].name || 'Operations Dashboard',
            message: 'Sharing this dashboard for your review',
            permissions: ['view_data', 'export'],
          },
        },
        {
          tenantId: dashboards[0].tenantId,
          sharedBy: users[0].id,
          resourceType: ShareResourceType.DASHBOARD,
          resourceId: dashboards[0].id,
          shareType: ShareType.LINK,
          accessLevel: AccessLevel.VIEW,
          token: generateToken(),
          isPublic: true,
          expiresAt: generateExpiresAt(7), // Expires in 7 days
          views: 42,
          lastViewedAt: new Date(Date.now() - 1800000), // 30 minutes ago
          metadata: {
            resourceName: dashboards[0].name || 'Public Dashboard',
            permissions: ['view_data'],
          },
        },
      );

      if (dashboards.length > 1 && users.length >= 3) {
        shares.push({
          tenantId: dashboards[1].tenantId,
          sharedBy: users[1]?.id || users[0].id,
          resourceType: ShareResourceType.DASHBOARD,
          resourceId: dashboards[1].id,
          shareType: ShareType.EMAIL,
          accessLevel: AccessLevel.EDIT,
          sharedWith: users[2]?.email || 'editor@smartlife.sa',
          isPublic: false,
          views: 8,
          lastViewedAt: new Date(Date.now() - 7200000), // 2 hours ago
          metadata: {
            resourceName: dashboards[1].name || 'Analytics Dashboard',
            message: 'You can edit this dashboard',
            permissions: ['view_data', 'edit', 'export'],
          },
        });
      }
    }

    // ════════════════════════════════════════════════════════════════
    // 2. DEVICE SHARES
    // ════════════════════════════════════════════════════════════════
    if (devices.length > 0) {
      shares.push(
        {
          tenantId: devices[0].tenantId,
          sharedBy: users[0].id,
          resourceType: ShareResourceType.DEVICE,
          resourceId: devices[0].id,
          shareType: ShareType.LINK,
          accessLevel: AccessLevel.VIEW,
          token: generateToken(),
          isPublic: true,
          expiresAt: generateExpiresAt(14), // 2 weeks
          views: 120,
          lastViewedAt: new Date(Date.now() - 600000), // 10 minutes ago
          metadata: {
            resourceName: devices[0].name || 'Temperature Sensor',
            permissions: ['view_telemetry'],
          },
        },
        {
          tenantId: devices[0].tenantId,
          sharedBy: users[0].id,
          resourceType: ShareResourceType.DEVICE,
          resourceId: devices[0].id,
          shareType: ShareType.EMAIL,
          accessLevel: AccessLevel.CONTROL,
          sharedWith: users[1]?.email || 'operator@smartlife.sa',
          isPublic: false,
          views: 5,
          lastViewedAt: new Date(Date.now() - 3600000),
          metadata: {
            resourceName: devices[0].name || 'HVAC Controller',
            message: 'You can control this device',
            permissions: ['view_telemetry', 'send_commands'],
          },
        },
      );

      if (devices.length > 1) {
        shares.push({
          tenantId: devices[1].tenantId,
          sharedBy: users[1]?.id || users[0].id,
          resourceType: ShareResourceType.DEVICE,
          resourceId: devices[1].id,
          shareType: ShareType.LINK,
          accessLevel: AccessLevel.VIEW,
          token: generateToken(),
          isPublic: false, // Private link
          expiresAt: generateExpiresAt(1), // Expires tomorrow
          views: 3,
          metadata: {
            resourceName: devices[1].name || 'Motion Sensor',
            permissions: ['view_telemetry'],
          },
        });
      }
    }

    // ════════════════════════════════════════════════════════════════
    // 3. ASSET SHARES
    // ════════════════════════════════════════════════════════════════
    if (assets.length > 0) {
      shares.push(
        {
          tenantId: assets[0].tenantId,
          sharedBy: users[0].id,
          resourceType: ShareResourceType.ASSET,
          resourceId: assets[0].id,
          shareType: ShareType.EMAIL,
          accessLevel: AccessLevel.ADMIN,
          sharedWith: 'manager@smartlife.sa',
          isPublic: false,
          views: 12,
          lastViewedAt: new Date(Date.now() - 86400000), // 1 day ago
          metadata: {
            resourceName: assets[0].name || 'Building HVAC',
            message: 'Full admin access for maintenance',
            permissions: ['view', 'edit', 'delete', 'manage_devices'],
          },
        },
        {
          tenantId: assets[0].tenantId,
          sharedBy: users[0].id,
          resourceType: ShareResourceType.ASSET,
          resourceId: assets[0].id,
          shareType: ShareType.LINK,
          accessLevel: AccessLevel.VIEW,
          token: generateToken(),
          isPublic: true,
          views: 89,
          lastViewedAt: new Date(Date.now() - 300000), // 5 minutes ago
          metadata: {
            resourceName: assets[0].name || 'Public Building',
            permissions: ['view'],
          },
        },
      );

      if (assets.length > 1 && users.length >= 3) {
        shares.push({
          tenantId: assets[1].tenantId,
          sharedBy: users[1]?.id || users[0].id,
          resourceType: ShareResourceType.ASSET,
          resourceId: assets[1].id,
          shareType: ShareType.EMAIL,
          accessLevel: AccessLevel.EDIT,
          sharedWith: users[2]?.email || 'technician@smartlife.sa',
          isPublic: false,
          expiresAt: generateExpiresAt(60), // 2 months
          views: 25,
          lastViewedAt: new Date(Date.now() - 43200000), // 12 hours ago
          metadata: {
            resourceName: assets[1].name || 'Floor 3 HVAC Zone',
            message: 'Access for configuration updates',
            permissions: ['view', 'edit', 'configure'],
          },
        });
      }
    }

    // ════════════════════════════════════════════════════════════════
    // 4. EXPIRED SHARE (for testing)
    // ════════════════════════════════════════════════════════════════
    if (dashboards.length > 0) {
      shares.push({
        tenantId: dashboards[0].tenantId,
        sharedBy: users[0].id,
        resourceType: ShareResourceType.DASHBOARD,
        resourceId: dashboards[0].id,
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        isPublic: true,
        expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
        views: 150,
        lastViewedAt: new Date(Date.now() - 172800000), // Last viewed 2 days ago
        metadata: {
          resourceName: 'Expired Dashboard Share',
          permissions: ['view_data'],
        },
      });
    }

    // ════════════════════════════════════════════════════════════════
    // 5. SAVE ALL SHARES
    // ════════════════════════════════════════════════════════════════
    let createdCount = 0;

    for (const shareData of shares) {
      try {
        const share = this.shareRepository.create(shareData);
        await this.shareRepository.save(share);

        const expiredTag = share.isExpired() ? '⏰ EXPIRED' : '';
        const publicTag = share.isPublic ? '🌐 PUBLIC' : '🔒 PRIVATE';

        this.logger.log(
          `✅ Created share: ${shareData.resourceType?.padEnd(12)} | ` +
          `Type: ${shareData.shareType?.padEnd(6)} | ` +
          `Access: ${shareData.accessLevel?.padEnd(8)} | ` +
          `${publicTag} ${expiredTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed share for ${shareData.resourceType} ${shareData.resourceId}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `🎉 Share seeding complete! Created ${createdCount}/${shares.length} shares with full coverage.`,
    );

    // ════════════════════════════════════════════════════════════════
    // 6. SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════
    const summary = {
      byType: {
        email: shares.filter(s => s.shareType === ShareType.EMAIL).length,
        link: shares.filter(s => s.shareType === ShareType.LINK).length,
      },
      byResource: {
        dashboards: shares.filter(s => s.resourceType === ShareResourceType.DASHBOARD).length,
        devices: shares.filter(s => s.resourceType === ShareResourceType.DEVICE).length,
        assets: shares.filter(s => s.resourceType === ShareResourceType.ASSET).length,
      },
      byAccess: {
        view: shares.filter(s => s.accessLevel === AccessLevel.VIEW).length,
        edit: shares.filter(s => s.accessLevel === AccessLevel.EDIT).length,
        control: shares.filter(s => s.accessLevel === AccessLevel.CONTROL).length,
        admin: shares.filter(s => s.accessLevel === AccessLevel.ADMIN).length,
      },
      public: shares.filter(s => s.isPublic).length,
      private: shares.filter(s => !s.isPublic).length,
      withExpiry: shares.filter(s => s.expiresAt).length,
      expired: shares.filter(s => s.expiresAt && new Date() > s.expiresAt).length,
    };

    this.logger.log('\n📊 Share Seeding Summary:');
    this.logger.log(`   Share Types: ${summary.byType.email} email, ${summary.byType.link} link`);
    this.logger.log(
      `   Resources: ${summary.byResource.dashboards} dashboards, ` +
      `${summary.byResource.devices} devices, ${summary.byResource.assets} assets`,
    );
    this.logger.log(
      `   Access Levels: ${summary.byAccess.view} view, ${summary.byAccess.edit} edit, ` +
      `${summary.byAccess.control} control, ${summary.byAccess.admin} admin`,
    );
    this.logger.log(`   Visibility: ${summary.public} public, ${summary.private} private`);
    this.logger.log(`   Expiry: ${summary.withExpiry} with expiry (${summary.expired} expired)`);
  }
}