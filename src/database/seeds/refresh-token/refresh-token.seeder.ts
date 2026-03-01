// src/database/seeds/refresh-token/refresh-token.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class RefreshTokenSeeder implements ISeeder {
  private readonly logger = new Logger(RefreshTokenSeeder.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting refresh token seeding...');

    // Check if refresh tokens already exist
    const existingTokens = await this.refreshTokenRepository.count();
    if (existingTokens > 0) {
      this.logger.log(`⏭️  Refresh tokens already seeded (${existingTokens} records). Skipping...`);
      return;
    }

    // Fetch users and tenants
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generateToken = (): string => {
      return crypto.randomBytes(64).toString('hex');
    };

    const generateExpiresAt = (daysFromNow: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return date;
    };

    const generatePastDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      return date;
    };

    const parseUserAgent = (ua: string): { browser: string; os: string; device: string } => {
      let browser = 'Unknown';
      let os = 'Unknown';
      let device = 'desktop';

      // Browser detection
      if (ua.includes('Chrome')) browser = 'Chrome';
      else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
      else if (ua.includes('Firefox')) browser = 'Firefox';
      else if (ua.includes('Edge') || ua.includes('Edg')) browser = 'Edge';

      // OS detection
      if (ua.includes('Windows')) os = 'Windows';
      else if (ua.includes('Mac OS X')) os = 'macOS';
      else if (ua.includes('Linux')) os = 'Linux';
      else if (ua.includes('iPhone')) os = 'iOS';
      else if (ua.includes('iPad')) os = 'iPadOS';
      else if (ua.includes('Android')) os = 'Android';

      // Device type detection
      if (ua.includes('Mobile') || ua.includes('iPhone')) device = 'mobile';
      else if (ua.includes('iPad') || ua.includes('Tablet')) device = 'tablet';

      return { browser, os, device };
    };

    // ════════════════════════════════════════════════════════════════
    // SAMPLE DATA
    // ════════════════════════════════════════════════════════════════

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];

    const locations = [
      { ipAddress: '185.45.123.45', country: 'Saudi Arabia', city: 'Riyadh' },
      { ipAddress: '185.45.124.56', country: 'Saudi Arabia', city: 'Jeddah' },
      { ipAddress: '185.45.125.67', country: 'Saudi Arabia', city: 'Dammam' },
      { ipAddress: '192.168.1.100', country: 'Saudi Arabia', city: 'Riyadh' },
      { ipAddress: '192.168.1.105', country: 'United Arab Emirates', city: 'Dubai' },
      { ipAddress: '10.0.0.50', country: 'Saudi Arabia', city: 'Riyadh' },
    ];

    // ════════════════════════════════════════════════════════════════
    // REFRESH TOKENS DATA
    // ════════════════════════════════════════════════════════════════

    const refreshTokens: Partial<RefreshToken>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. ACTIVE TOKEN - Windows Desktop
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[0],
          ...parseUserAgent(userAgents[0]),
          ipAddress: locations[0].ipAddress,
          country: locations[0].country,
          city: locations[0].city,
          lastUsedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 2. ACTIVE TOKEN - iPhone
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[2],
          ...parseUserAgent(userAgents[2]),
          ipAddress: locations[4].ipAddress,
          country: locations[4].country,
          city: locations[4].city,
          lastUsedAt: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 3. ACTIVE TOKEN - MacBook
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[1],
          ...parseUserAgent(userAgents[1]),
          ipAddress: locations[1].ipAddress,
          country: locations[1].country,
          city: locations[1].city,
          lastUsedAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 4. ACTIVE TOKEN - iPad
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[3],
          ...parseUserAgent(userAgents[3]),
          ipAddress: locations[2].ipAddress,
          country: locations[2].country,
          city: locations[2].city,
          lastUsedAt: new Date(Date.now() - 1800000).toISOString(), // 30 minutes ago
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 5. ACTIVE TOKEN - Android
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(15),
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[4],
          ...parseUserAgent(userAgents[4]),
          ipAddress: locations[3].ipAddress,
          country: locations[3].country,
          city: locations[3].city,
          lastUsedAt: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 6. EXPIRED TOKEN
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        expiresAt: generatePastDate(5), // Expired 5 days ago
        isRevoked: false,
        deviceInfo: {
          userAgent: userAgents[1],
          ...parseUserAgent(userAgents[1]),
          ipAddress: getRandomItem(locations).ipAddress,
          country: 'Saudi Arabia',
          city: 'Riyadh',
          lastUsedAt: generatePastDate(5).toISOString(),
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 7. REVOKED TOKEN
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: true,
        revokedAt: new Date(Date.now() - 86400000), // Revoked 1 day ago
        deviceInfo: {
          userAgent: userAgents[2],
          ...parseUserAgent(userAgents[2]),
          ipAddress: getRandomItem(locations).ipAddress,
          country: 'Saudi Arabia',
          city: 'Jeddah',
          lastUsedAt: generatePastDate(1).toISOString(),
        },
      },

      // ════════════════════════════════════════════════════════════════
      // 8. EXPIRED + REVOKED TOKEN (for testing cleanup)
      // ════════════════════════════════════════════════════════════════
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        expiresAt: generatePastDate(10), // Expired 10 days ago
        isRevoked: true,
        revokedAt: generatePastDate(11),
        deviceInfo: {
          userAgent: userAgents[4],
          ...parseUserAgent(userAgents[4]),
          ipAddress: getRandomItem(locations).ipAddress,
          country: 'Saudi Arabia',
          city: 'Dammam',
          lastUsedAt: generatePastDate(10).toISOString(),
        },
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL TOKENS
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const tokenData of refreshTokens) {
      try {
        const token = this.refreshTokenRepository.create(tokenData);
        await this.refreshTokenRepository.save(token);

        const statusTag = token.isRevoked
          ? '🔒 REVOKED'
          : token.isExpired()
            ? '⏰ EXPIRED'
            : '✅ ACTIVE';

        const deviceDesc = token.getDeviceDescription();
        const locationDesc = token.getLocationDescription();

        this.logger.log(
          `✅ Created token: ${deviceDesc.padEnd(30)} | ${locationDesc.padEnd(25)} | ${statusTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed refresh token: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `🎉 Refresh token seeding complete! Created ${createdCount}/${refreshTokens.length} tokens.`,
    );

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      active: refreshTokens.filter(
        t => !t.isRevoked && new Date() < (t.expiresAt || new Date()),
      ).length,
      expired: refreshTokens.filter(
        t => !t.isRevoked && new Date() > (t.expiresAt || new Date()),
      ).length,
      revoked: refreshTokens.filter(t => t.isRevoked).length,
      byDevice: {
        mobile: refreshTokens.filter(t => t.deviceInfo?.device === 'mobile').length,
        tablet: refreshTokens.filter(t => t.deviceInfo?.device === 'tablet').length,
        desktop: refreshTokens.filter(t => t.deviceInfo?.device === 'desktop').length,
      },
    };

    this.logger.log('\n📊 Refresh Token Seeding Summary:');
    this.logger.log(`   Status: ${summary.active} active, ${summary.expired} expired, ${summary.revoked} revoked`);
    this.logger.log(
      `   Devices: ${summary.byDevice.desktop} desktop, ${summary.byDevice.mobile} mobile, ${summary.byDevice.tablet} tablet`,
    );
  }
}