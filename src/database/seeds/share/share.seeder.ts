import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ResourceType,
  ShareType,
  AccessLevel,
} from '@modules/sharing/entities/sharing.entity';
import { Share, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class ShareSeeder implements ISeeder {
  constructor(
    @InjectRepository(Share)
    private readonly shareRepository: Repository<Share>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all users first
    const users = await this.userRepository.find({ take: 10 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper function to generate random token
    const generateToken = (): string => {
      return crypto.randomBytes(32).toString('hex');
    };

    // Helper function to generate expiration date
    const generateExpiresAt = (daysFromNow: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return date;
    };

    // Generate fake resource IDs
    const generateResourceId = (type: string): string => {
      return `${type}-${crypto.randomBytes(8).toString('hex')}`;
    };

    const shares = [
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.EMAIL,
        sharedWith: users[1]?.email || 'colleague@example.com',
        accessLevel: AccessLevel.VIEW,
        sharedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
        views: 15,
        isPublic: false,
        metadata: {
          resourceName: 'Operations Dashboard',
          message: 'Check out our latest operational metrics',
          permissions: ['view_data', 'export_data'],
        },
      },
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(7),
        sharedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
        views: 42,
        isPublic: true,
        metadata: {
          resourceName: 'Public Performance Dashboard',
          permissions: ['view_data'],
        },
      },
      {
        resourceType: ResourceType.DEVICE,
        resourceId: generateResourceId('device'),
        shareType: ShareType.EMAIL,
        sharedWith: users[2]?.email || users[0].email,
        accessLevel: AccessLevel.EDIT,
        sharedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
        views: 8,
        isPublic: false,
        metadata: {
          resourceName: 'Temperature Sensor #A-101',
          message: 'Sharing device access for configuration',
          permissions: ['view_device', 'edit_device', 'view_telemetry'],
        },
      },
      {
        resourceType: ResourceType.REPORT,
        resourceId: generateResourceId('report'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(30),
        sharedBy: users[1]?.id || users[0].id,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
        views: 127,
        isPublic: true,
        metadata: {
          resourceName: 'Q4 2025 Analytics Report',
          permissions: ['view_report', 'download_report'],
        },
      },
      {
        resourceType: ResourceType.FLOOR_PLAN,
        resourceId: generateResourceId('floorplan'),
        shareType: ShareType.EMAIL,
        sharedWith: 'engineer@example.com',
        accessLevel: AccessLevel.VIEW,
        sharedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
        views: 3,
        isPublic: false,
        metadata: {
          resourceName: 'Factory Floor Plan - Building A',
          message: 'Please review the device placement layout',
          permissions: ['view_floorplan'],
        },
      },
      {
        resourceType: ResourceType.ASSET,
        resourceId: generateResourceId('asset'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(14),
        sharedBy: users[2]?.id || users[0].id,
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
        views: 25,
        isPublic: false,
        metadata: {
          resourceName: 'HVAC System Asset',
          permissions: ['view_asset', 'view_history'],
        },
      },
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.EMAIL,
        sharedWith: users[1]?.email || users[0].email,
        accessLevel: AccessLevel.ADMIN,
        sharedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
        views: 52,
        isPublic: false,
        metadata: {
          resourceName: 'Admin Dashboard',
          message: 'Full admin access granted',
          permissions: [
            'view_data',
            'edit_dashboard',
            'manage_widgets',
            'delete_dashboard',
          ],
        },
      },
      {
        resourceType: ResourceType.REPORT,
        resourceId: generateResourceId('report'),
        shareType: ShareType.EMAIL,
        sharedWith: 'manager@example.com',
        accessLevel: AccessLevel.VIEW,
        expiresAt: generateExpiresAt(7),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 12,
        isPublic: false,
        metadata: {
          resourceName: 'Weekly Performance Report',
          message: 'This weeks performance summary',
          permissions: ['view_report'],
        },
      },
      {
        resourceType: ResourceType.DEVICE,
        resourceId: generateResourceId('device'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 0, // New share, no views yet
        isPublic: true,
        metadata: {
          resourceName: 'Public Weather Station',
          permissions: ['view_device', 'view_telemetry'],
        },
      },
      {
        resourceType: ResourceType.FLOOR_PLAN,
        resourceId: generateResourceId('floorplan'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.EDIT,
        token: generateToken(),
        expiresAt: generateExpiresAt(30),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 7,
        isPublic: false,
        metadata: {
          resourceName: 'Office Floor Plan - Level 5',
          permissions: ['view_floorplan', 'edit_floorplan', 'manage_devices'],
        },
      },
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(365), // 1 year
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 1543,
        isPublic: true,
        metadata: {
          resourceName: 'Public Energy Dashboard',
          permissions: ['view_data'],
        },
      },
      {
        resourceType: ResourceType.ASSET,
        resourceId: generateResourceId('asset'),
        shareType: ShareType.EMAIL,
        sharedWith: 'maintenance@example.com',
        accessLevel: AccessLevel.VIEW,
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 18,
        isPublic: false,
        metadata: {
          resourceName: 'Pump Station Asset #3',
          message: 'Review asset details for scheduled maintenance',
          permissions: ['view_asset', 'view_maintenance_history'],
        },
      },
      {
        resourceType: ResourceType.REPORT,
        resourceId: generateResourceId('report'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(1), // Expires tomorrow
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 89,
        isPublic: false,
        metadata: {
          resourceName: 'Security Audit Report',
          permissions: ['view_report'],
        },
      },
      {
        resourceType: ResourceType.DEVICE,
        resourceId: generateResourceId('device'),
        shareType: ShareType.EMAIL,
        sharedWith: users[2]?.email || users[0].email,
        accessLevel: AccessLevel.EDIT,
        expiresAt: generateExpiresAt(60),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 34,
        isPublic: false,
        metadata: {
          resourceName: 'Smart Thermostat - Office 302',
          message: 'Granting configuration access',
          permissions: ['view_device', 'edit_device', 'send_commands'],
        },
      },
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 256,
        isPublic: true,
        metadata: {
          resourceName: 'Real-time Monitoring Dashboard',
          permissions: ['view_data', 'refresh_data'],
        },
      },
      {
        resourceType: ResourceType.FLOOR_PLAN,
        resourceId: generateResourceId('floorplan'),
        shareType: ShareType.EMAIL,
        sharedWith: 'architect@example.com',
        accessLevel: AccessLevel.VIEW,
        expiresAt: generateExpiresAt(14),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 5,
        isPublic: false,
        metadata: {
          resourceName: 'Warehouse Layout - Zone A',
          message: 'Please review the proposed device placement',
          permissions: ['view_floorplan'],
        },
      },
      {
        resourceType: ResourceType.REPORT,
        resourceId: generateResourceId('report'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(90),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 203,
        isPublic: true,
        metadata: {
          resourceName: 'Annual Sustainability Report 2025',
          permissions: ['view_report', 'download_report'],
        },
      },
      {
        resourceType: ResourceType.ASSET,
        resourceId: generateResourceId('asset'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(30),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 67,
        isPublic: false,
        metadata: {
          resourceName: 'Generator Asset #12',
          permissions: ['view_asset', 'view_telemetry'],
        },
      },
      {
        resourceType: ResourceType.DEVICE,
        resourceId: generateResourceId('device'),
        shareType: ShareType.LINK,
        accessLevel: AccessLevel.VIEW,
        token: generateToken(),
        expiresAt: generateExpiresAt(7),
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 14,
        isPublic: false,
        metadata: {
          resourceName: 'Access Control Panel - Main Entrance',
          permissions: ['view_device', 'view_logs'],
        },
      },
      {
        resourceType: ResourceType.DASHBOARD,
        resourceId: generateResourceId('dashboard'),
        shareType: ShareType.EMAIL,
        sharedWith: 'executive@example.com',
        accessLevel: AccessLevel.VIEW,
        sharedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        views: 98,
        isPublic: false,
        metadata: {
          resourceName: 'Executive Summary Dashboard',
          message: 'Monthly executive overview',
          permissions: ['view_data', 'export_data'],
        },
      },
    ];

    for (const shareData of shares) {
      const share = this.shareRepository.create(shareData);
      await this.shareRepository.save(share);
      console.log(
        `✅ Created share: ${shareData.resourceType} - ${shareData.metadata?.resourceName} (${shareData.shareType} - ${shareData.accessLevel})`,
      );
    }

    console.log('🎉 Share seeding completed!');
  }
}
