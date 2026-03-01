// src/database/seeds/image/image.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Image, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class ImageSeeder implements ISeeder {
  private readonly logger = new Logger(ImageSeeder.name);

  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting image seeding...');

    // Check if images already exist
    const existingImages = await this.imageRepository.count();
    if (existingImages > 0) {
      this.logger.log(
        `⏭️  Images already seeded (${existingImages} records). Skipping...`,
      );
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    this.logger.log(`📊 Found ${users.length} users, ${tenants.length} tenants`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generateFileSize = (minMB: number, maxMB: number): number => {
      return Math.floor(
        (Math.random() * (maxMB - minMB) + minMB) * 1024 * 1024,
      );
    };

    const generateDimensions = () => {
      const widths = [1920, 1280, 800, 1024, 2048, 3840, 1600, 1366];
      const heights = [1080, 720, 600, 768, 1536, 2160, 900, 768];
      const index = Math.floor(Math.random() * widths.length);
      const width = widths[index];
      const height = heights[index];
      return {
        width,
        height,
        aspectRatio: parseFloat((width / height).toFixed(2)),
      };
    };

    const generateThumbnails = (baseUrl: string, baseName: string) => {
      const baseUrlWithoutExt = baseUrl.replace(/\.[^/.]+$/, '');
      return {
        small: {
          url: `${baseUrlWithoutExt}-thumb-small.jpg`,
          width: 150,
          height: 150,
        },
        medium: {
          url: `${baseUrlWithoutExt}-thumb-medium.jpg`,
          width: 300,
          height: 300,
        },
        large: {
          url: `${baseUrlWithoutExt}-thumb-large.jpg`,
          width: 600,
          height: 600,
        },
      };
    };

    // ════════════════════════════════════════════════════════════════
    // IMAGE DATA
    // ════════════════════════════════════════════════════════════════

    const images: Partial<Image>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. SENSOR DASHBOARD SCREENSHOT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        uploadedBy: users[0].email || users[0].name,
        name: 'sensor-dashboard-screenshot.png',
        originalName: 'Dashboard Screenshot 2025.png',
        mimeType: 'image/png',
        size: generateFileSize(0.5, 2),
        url: 'https://storage.example.com/images/sensor-dashboard-screenshot.png',
        path: '/uploads/images/2025/11/sensor-dashboard-screenshot.png',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: generateDimensions(),
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/sensor-dashboard-screenshot.png',
          'sensor-dashboard-screenshot',
        ),
        entityType: 'dashboard',
        entityId: 'dashboard-001',
        fieldName: 'screenshot',
        alt: 'Sensor monitoring dashboard screenshot',
        title: 'Dashboard Screenshot',
        description: 'Real-time sensor monitoring dashboard overview',
        isPublic: false,
        viewCount: 45,
        downloadCount: 12,
        tags: ['dashboard', 'screenshot', 'monitoring'],
      },

      // ════════════════════════════════════════════════════════════════
      // 2. DEVICE INSTALLATION PHOTO
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        uploadedBy: users[0].email || users[0].name,
        name: 'device-installation-photo.jpg',
        originalName: 'IMG_20251105_143022.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(2, 5),
        url: 'https://storage.example.com/images/device-installation-photo.jpg',
        path: '/uploads/images/2025/11/device-installation-photo.jpg',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 4032,
          height: 3024,
          aspectRatio: 1.33,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/device-installation-photo.jpg',
          'device-installation-photo',
        ),
        entityType: 'device',
        entityId: 'device-001',
        fieldName: 'installationPhoto',
        alt: 'IoT device installation in server room',
        title: 'Device Installation',
        description: 'Temperature sensor installed in server room',
        isPublic: false,
        viewCount: 89,
        downloadCount: 23,
        tags: ['device', 'installation', 'photo'],
        exif: {
          Make: 'Apple',
          Model: 'iPhone 15 Pro',
          DateTime: '2025:11:05 14:30:22',
          GPS: { Latitude: 24.7136, Longitude: 46.6753 },
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 3. FLOOR PLAN
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        uploadedBy: users[1]?.email || users[0].email,
        name: 'floor-plan-warehouse-a.png',
        originalName: 'Warehouse A Floor Plan.png',
        mimeType: 'image/png',
        size: generateFileSize(1, 3),
        url: 'https://storage.example.com/images/floor-plan-warehouse-a.png',
        path: '/uploads/images/2025/11/floor-plan-warehouse-a.png',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 2048,
          height: 1536,
          aspectRatio: 1.33,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/floor-plan-warehouse-a.png',
          'floor-plan-warehouse-a',
        ),
        entityType: 'floor_plan',
        entityId: 'floor-plan-001',
        fieldName: 'blueprint',
        alt: 'Warehouse A floor plan with device locations',
        title: 'Warehouse A Floor Plan',
        description: 'Floor plan showing sensor and device placement',
        isPublic: false,
        viewCount: 156,
        downloadCount: 45,
        tags: ['floor-plan', 'warehouse', 'blueprint'],
      },

      // ════════════════════════════════════════════════════════════════
      // 4. THERMAL CAMERA CAPTURE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        uploadedBy: users[0].email || users[0].name,
        name: 'thermal-camera-capture.jpg',
        originalName: 'Thermal_Scan_001.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1.5, 3),
        url: 'https://storage.example.com/images/thermal-camera-capture.jpg',
        path: '/uploads/images/2025/11/thermal-camera-capture.jpg',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 640,
          height: 480,
          aspectRatio: 1.33,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/thermal-camera-capture.jpg',
          'thermal-camera-capture',
        ),
        entityType: 'device',
        entityId: 'device-thermal-001',
        fieldName: 'capture',
        alt: 'Thermal imaging camera capture',
        title: 'Thermal Scan',
        description: 'Temperature distribution scan of equipment',
        isPublic: false,
        viewCount: 234,
        downloadCount: 67,
        tags: ['thermal', 'camera', 'temperature', 'scan'],
      },

      // ════════════════════════════════════════════════════════════════
      // 5. NETWORK DIAGRAM (SVG)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        uploadedBy: users[2]?.email || users[0].email,
        name: 'sensor-network-diagram.svg',
        originalName: 'Network Diagram.svg',
        mimeType: 'image/svg+xml',
        size: generateFileSize(0.1, 0.5),
        url: 'https://storage.example.com/images/sensor-network-diagram.svg',
        path: '/uploads/images/2025/11/sensor-network-diagram.svg',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        entityType: 'documentation',
        entityId: 'doc-network-001',
        fieldName: 'diagram',
        alt: 'Sensor network topology diagram',
        title: 'Network Diagram',
        description: 'IoT sensor network architecture and connections',
        isPublic: true,
        viewCount: 567,
        downloadCount: 123,
        tags: ['diagram', 'network', 'topology', 'svg'],
      },

      // ════════════════════════════════════════════════════════════════
      // 6. COMPANY LOGO
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        uploadedBy: users[0].email || users[0].name,
        name: 'company-logo.png',
        originalName: 'Logo_Final.png',
        mimeType: 'image/png',
        size: generateFileSize(0.1, 0.5),
        url: 'https://storage.example.com/images/company-logo.png',
        path: '/uploads/images/2025/09/company-logo.png',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 512,
          height: 512,
          aspectRatio: 1.0,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/company-logo.png',
          'company-logo',
        ),
        entityType: 'tenant',
        entityId: users[0].tenantId || tenants[0].id,
        fieldName: 'logo',
        alt: 'Smart Life company logo',
        title: 'Company Logo',
        description: 'Official Smart Life IoT Platform logo',
        isPublic: true,
        viewCount: 1234,
        downloadCount: 456,
        tags: ['logo', 'branding', 'company'],
      },

      // ════════════════════════════════════════════════════════════════
      // 7. USER PROFILE AVATAR
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        uploadedBy: users[0].email || users[0].name,
        name: 'user-profile-avatar.jpg',
        originalName: 'Profile_Picture.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(0.2, 0.8),
        url: 'https://storage.example.com/images/user-profile-avatar.jpg',
        path: '/uploads/images/2025/10/user-profile-avatar.jpg',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 800,
          height: 800,
          aspectRatio: 1.0,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/user-profile-avatar.jpg',
          'user-profile-avatar',
        ),
        entityType: 'user',
        entityId: users[0].id,
        fieldName: 'avatar',
        alt: 'User profile photo',
        title: 'Profile Picture',
        description: 'User profile avatar image',
        isPublic: false,
        viewCount: 89,
        downloadCount: 5,
        tags: ['profile', 'avatar', 'user'],
      },

      // ════════════════════════════════════════════════════════════════
      // 8. QR CODE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        uploadedBy: getRandomItem(users).email,
        name: 'asset-tag-qr-code.png',
        originalName: 'QR_Asset_Tag_A001.png',
        mimeType: 'image/png',
        size: generateFileSize(0.05, 0.2),
        url: 'https://storage.example.com/images/asset-tag-qr-code.png',
        path: '/uploads/images/2025/11/asset-tag-qr-code.png',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 512,
          height: 512,
          aspectRatio: 1.0,
        },
        entityType: 'asset',
        entityId: 'asset-001',
        fieldName: 'qrCode',
        alt: 'Asset QR code tag',
        title: 'Asset Tag QR Code',
        description: 'QR code for asset tracking',
        isPublic: false,
        viewCount: 345,
        downloadCount: 89,
        tags: ['qr-code', 'asset', 'tracking'],
      },

      // ════════════════════════════════════════════════════════════════
      // 9. TEMPERATURE HEATMAP
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        uploadedBy: getRandomItem(users).email,
        name: 'temperature-heatmap.png',
        originalName: 'Temperature Heatmap Nov 5.png',
        mimeType: 'image/png',
        size: generateFileSize(1, 2),
        url: 'https://storage.example.com/images/temperature-heatmap.png',
        path: '/uploads/images/2025/11/temperature-heatmap.png',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: generateDimensions(),
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/temperature-heatmap.png',
          'temperature-heatmap',
        ),
        entityType: 'report',
        entityId: 'report-temp-001',
        fieldName: 'visualization',
        alt: 'Temperature distribution heatmap',
        title: 'Temperature Heatmap',
        description: 'Building temperature distribution analysis',
        isPublic: false,
        viewCount: 456,
        downloadCount: 123,
        tags: ['heatmap', 'temperature', 'analytics', 'visualization'],
      },

      // ════════════════════════════════════════════════════════════════
      // 10. SECURITY CAMERA SNAPSHOT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        uploadedBy: getRandomItem(users).email,
        name: 'security-camera-snapshot.jpg',
        originalName: 'Camera_01_Snapshot_20251105.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1, 2),
        url: 'https://storage.example.com/images/security-camera-snapshot.jpg',
        path: '/uploads/images/2025/11/security-camera-snapshot.jpg',
        storageProvider: 's3',
        bucket: 'smartlife-images',
        dimensions: {
          width: 1280,
          height: 720,
          aspectRatio: 1.78,
        },
        thumbnails: generateThumbnails(
          'https://storage.example.com/images/security-camera-snapshot.jpg',
          'security-camera-snapshot',
        ),
        entityType: 'device',
        entityId: 'device-camera-001',
        fieldName: 'snapshot',
        alt: 'Security camera snapshot',
        title: 'Camera Snapshot',
        description: 'Security camera snapshot from entrance',
        isPublic: false,
        viewCount: 789,
        downloadCount: 34,
        tags: ['security', 'camera', 'snapshot', 'surveillance'],
        exif: {
          Make: 'Hikvision',
          Model: 'DS-2CD2345',
          DateTime: '2025:11:05 08:15:30',
        },
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL IMAGES
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;
    let totalSize = 0;

    for (const imageData of images) {
      try {
        const image = this.imageRepository.create(imageData);
        await this.imageRepository.save(image);

        totalSize += imageData.size || 0;
        const sizeInMB = ((imageData.size || 0) / (1024 * 1024)).toFixed(2);
        const typeTag = image.isVector() ? '📐 SVG' : image.isPhoto() ? '📷 PHOTO' : '🖼️  IMAGE';

        this.logger.log(
          `✅ Created: ${image.name.substring(0, 40).padEnd(42)} | ` +
          `${sizeInMB.padStart(6)} MB | ${typeTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed image '${imageData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      byType: {} as Record<string, number>,
      byEntityType: {} as Record<string, number>,
      public: images.filter(i => i.isPublic).length,
      private: images.filter(i => !i.isPublic).length,
      withThumbnails: images.filter(i => i.thumbnails).length,
      totalViews: images.reduce((sum, i) => sum + (i.viewCount || 0), 0),
      totalDownloads: images.reduce((sum, i) => sum + (i.downloadCount || 0), 0),
    };

    images.forEach((i) => {
      if (i.mimeType) {
        summary.byType[i.mimeType] = (summary.byType[i.mimeType] || 0) + 1;
      }
      if (i.entityType) {
        summary.byEntityType[i.entityType] = (summary.byEntityType[i.entityType] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Image seeding complete! Created ${createdCount}/${images.length} images.`,
    );
    this.logger.log('');
    this.logger.log('📊 Image Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   Total Size: ${summary.totalSizeMB} MB`);
    this.logger.log(`   Public: ${summary.public} | Private: ${summary.private}`);
    this.logger.log(`   With Thumbnails: ${summary.withThumbnails}`);
    this.logger.log(`   Total Views: ${summary.totalViews}`);
    this.logger.log(`   Total Downloads: ${summary.totalDownloads}`);
    this.logger.log('');
    this.logger.log('   By MIME Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(20)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Entity Type:');
    Object.entries(summary.byEntityType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(20)}: ${count}`),
    );
  }
}