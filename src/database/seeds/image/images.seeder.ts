import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Image, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class ImageSeeder implements ISeeder {
  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
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

    // Helper function to generate random file size
    const generateFileSize = (minMB: number, maxMB: number): number => {
      return Math.floor(
        (Math.random() * (maxMB - minMB) + minMB) * 1024 * 1024,
      );
    };

    // Helper function to generate random dimensions
    const generateDimensions = () => {
      const widths = [1920, 1280, 800, 1024, 2048, 3840, 1600, 1366];
      const heights = [1080, 720, 600, 768, 1536, 2160, 900, 768];
      const index = Math.floor(Math.random() * widths.length);
      return {
        width: widths[index],
        height: heights[index],
      };
    };

    const images = [
      {
        name: 'sensor-dashboard-screenshot.png',
        originalName: 'Dashboard Screenshot 2025.png',
        mimeType: 'image/png',
        size: generateFileSize(0.5, 2),
        url: 'https://storage.example.com/images/sensor-dashboard-screenshot.png',
        path: '/uploads/images/2025/11/sensor-dashboard-screenshot.png',
        dimensions: generateDimensions(),
        uploadedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'device-installation-photo.jpg',
        originalName: 'IMG_20251105_143022.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(2, 5),
        url: 'https://storage.example.com/images/device-installation-photo.jpg',
        path: '/uploads/images/2025/11/device-installation-photo.jpg',
        dimensions: {
          width: 4032,
          height: 3024,
        },
        uploadedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'floor-plan-warehouse-a.png',
        originalName: 'Warehouse A Floor Plan.png',
        mimeType: 'image/png',
        size: generateFileSize(1, 3),
        url: 'https://storage.example.com/images/floor-plan-warehouse-a.png',
        path: '/uploads/images/2025/11/floor-plan-warehouse-a.png',
        dimensions: {
          width: 2048,
          height: 1536,
        },
        uploadedBy: users[1]?.id || users[0].id,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'thermal-camera-capture.jpg',
        originalName: 'Thermal_Scan_001.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1.5, 3),
        url: 'https://storage.example.com/images/thermal-camera-capture.jpg',
        path: '/uploads/images/2025/11/thermal-camera-capture.jpg',
        dimensions: {
          width: 640,
          height: 480,
        },
        uploadedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'equipment-maintenance-log.png',
        originalName: 'Maintenance Log Oct 2025.png',
        mimeType: 'image/png',
        size: generateFileSize(0.8, 2),
        url: 'https://storage.example.com/images/equipment-maintenance-log.png',
        path: '/uploads/images/2025/10/equipment-maintenance-log.png',
        dimensions: generateDimensions(),
        uploadedBy: users[1]?.id || users[0].id,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'sensor-network-diagram.svg',
        originalName: 'Network Diagram.svg',
        mimeType: 'image/svg+xml',
        size: generateFileSize(0.1, 0.5),
        url: 'https://storage.example.com/images/sensor-network-diagram.svg',
        path: '/uploads/images/2025/11/sensor-network-diagram.svg',
        uploadedBy: users[2]?.id || users[0].id,
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'production-line-overview.jpg',
        originalName: 'Production Line Photo.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(3, 6),
        url: 'https://storage.example.com/images/production-line-overview.jpg',
        path: '/uploads/images/2025/11/production-line-overview.jpg',
        dimensions: {
          width: 3840,
          height: 2160,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'alarm-notification-screenshot.png',
        originalName: 'Alarm Notification.png',
        mimeType: 'image/png',
        size: generateFileSize(0.5, 1.5),
        url: 'https://storage.example.com/images/alarm-notification-screenshot.png',
        path: '/uploads/images/2025/11/alarm-notification-screenshot.png',
        dimensions: {
          width: 1920,
          height: 1080,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'iot-device-model-3d.png',
        originalName: '3D Model Render.png',
        mimeType: 'image/png',
        size: generateFileSize(2, 4),
        url: 'https://storage.example.com/images/iot-device-model-3d.png',
        path: '/uploads/images/2025/11/iot-device-model-3d.png',
        dimensions: {
          width: 2560,
          height: 1440,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'data-center-rack-photo.jpg',
        originalName: 'Rack_Configuration_2025.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(2.5, 5),
        url: 'https://storage.example.com/images/data-center-rack-photo.jpg',
        path: '/uploads/images/2025/11/data-center-rack-photo.jpg',
        dimensions: {
          width: 4000,
          height: 3000,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'energy-consumption-chart.png',
        originalName: 'Energy Chart October.png',
        mimeType: 'image/png',
        size: generateFileSize(0.6, 1.8),
        url: 'https://storage.example.com/images/energy-consumption-chart.png',
        path: '/uploads/images/2025/10/energy-consumption-chart.png',
        dimensions: generateDimensions(),
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'company-logo.png',
        originalName: 'Logo_Final.png',
        mimeType: 'image/png',
        size: generateFileSize(0.1, 0.5),
        url: 'https://storage.example.com/images/company-logo.png',
        path: '/uploads/images/2025/09/company-logo.png',
        dimensions: {
          width: 512,
          height: 512,
        },
        uploadedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'asset-tag-qr-code.png',
        originalName: 'QR_Asset_Tag_A001.png',
        mimeType: 'image/png',
        size: generateFileSize(0.05, 0.2),
        url: 'https://storage.example.com/images/asset-tag-qr-code.png',
        path: '/uploads/images/2025/11/asset-tag-qr-code.png',
        dimensions: {
          width: 512,
          height: 512,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'safety-compliance-certificate.jpg',
        originalName: 'Safety Certificate 2025.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1, 2.5),
        url: 'https://storage.example.com/images/safety-compliance-certificate.jpg',
        path: '/uploads/images/2025/11/safety-compliance-certificate.jpg',
        dimensions: {
          width: 2480,
          height: 3508,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'warehouse-inventory-scan.jpg',
        originalName: 'Inventory_Scan_20251104.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(2, 4),
        url: 'https://storage.example.com/images/warehouse-inventory-scan.jpg',
        path: '/uploads/images/2025/11/warehouse-inventory-scan.jpg',
        dimensions: {
          width: 3264,
          height: 2448,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'temperature-heatmap.png',
        originalName: 'Temperature Heatmap Nov 5.png',
        mimeType: 'image/png',
        size: generateFileSize(1, 2),
        url: 'https://storage.example.com/images/temperature-heatmap.png',
        path: '/uploads/images/2025/11/temperature-heatmap.png',
        dimensions: generateDimensions(),
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'user-profile-avatar.jpg',
        originalName: 'Profile_Picture.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(0.2, 0.8),
        url: 'https://storage.example.com/images/user-profile-avatar.jpg',
        path: '/uploads/images/2025/10/user-profile-avatar.jpg',
        dimensions: {
          width: 800,
          height: 800,
        },
        uploadedBy: users[0].id,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'installation-manual-page.png',
        originalName: 'Manual Page 15.png',
        mimeType: 'image/png',
        size: generateFileSize(0.8, 2),
        url: 'https://storage.example.com/images/installation-manual-page.png',
        path: '/uploads/images/2025/11/installation-manual-page.png',
        dimensions: {
          width: 1754,
          height: 2480,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'analytics-report-cover.jpg',
        originalName: 'Q4 Report Cover.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1.5, 3),
        url: 'https://storage.example.com/images/analytics-report-cover.jpg',
        path: '/uploads/images/2025/10/analytics-report-cover.jpg',
        dimensions: {
          width: 1920,
          height: 1080,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'security-camera-snapshot.jpg',
        originalName: 'Camera_01_Snapshot_20251105.jpg',
        mimeType: 'image/jpeg',
        size: generateFileSize(1, 2),
        url: 'https://storage.example.com/images/security-camera-snapshot.jpg',
        path: '/uploads/images/2025/11/security-camera-snapshot.jpg',
        dimensions: {
          width: 1280,
          height: 720,
        },
        uploadedBy: getRandomItem(users).id,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const imageData of images) {
      const existing = await this.imageRepository.findOne({
        where: { name: imageData.name, userId: imageData.userId },
      });

      if (!existing) {
        const image = this.imageRepository.create(imageData);
        await this.imageRepository.save(image);
        console.log(
          `✅ Created image: ${imageData.name} (${(imageData.size / (1024 * 1024)).toFixed(2)} MB)`,
        );
      } else {
        console.log(`⏭️  Image already exists: ${imageData.name}`);
      }
    }

    console.log('🎉 Image seeding completed!');
  }
}
