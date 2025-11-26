import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';
import * as crypto from 'crypto';

@Injectable()
export class RefreshTokenSeeder implements ISeeder {
  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
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
      return crypto.randomBytes(64).toString('hex');
    };

    // Helper function to generate expiration date
    const generateExpiresAt = (daysFromNow: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return date;
    };

    // Helper function to generate past date
    const generatePastDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      return date;
    };

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];

    const deviceInfos = [
      'Windows Desktop - Chrome',
      'MacBook Pro - Chrome',
      'iPhone 15 Pro - Safari',
      'iPad Air - Safari',
      'Samsung Galaxy S24 - Chrome',
      'Linux Workstation - Chrome',
      'MacBook Air - Safari',
      'iPhone 14 - Safari',
      'Pixel 8 Pro - Chrome',
      'Windows Laptop - Edge',
    ];

    const ipAddresses = [
      '192.168.1.100',
      '192.168.1.101',
      '192.168.1.102',
      '10.0.0.50',
      '10.0.0.51',
      '172.16.0.25',
      '172.16.0.26',
      '192.168.0.45',
      '192.168.0.46',
      '10.1.1.30',
    ];

    const refreshTokens = [
      {
        token: generateToken(),
        userId: users[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'Windows Desktop - Chrome',
        ipAddress: '192.168.1.100',
        userAgent: userAgents[0],
      },
      {
        token: generateToken(),
        userId: users[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'iPhone 15 Pro - Safari',
        ipAddress: '192.168.1.105',
        userAgent: userAgents[2],
      },
      {
        token: generateToken(),
        userId: users[1]?.id || users[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'MacBook Pro - Chrome',
        ipAddress: '192.168.1.110',
        userAgent: userAgents[1],
      },
      {
        token: generateToken(),
        userId: users[1]?.id || users[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'iPad Air - Safari',
        ipAddress: '192.168.1.111',
        userAgent: userAgents[3],
      },
      {
        token: generateToken(),
        userId: users[2]?.id || users[0].id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'Samsung Galaxy S24 - Chrome',
        ipAddress: '192.168.1.120',
        userAgent: userAgents[4],
      },
      {
        token: generateToken(),
        userId: users[2]?.id || users[0].id,
        expiresAt: generateExpiresAt(15),
        isRevoked: false,
        deviceInfo: 'Linux Workstation - Chrome',
        ipAddress: '10.0.0.50',
        userAgent: userAgents[5],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generatePastDate(-5), // Expired 5 days ago
        isRevoked: false,
        deviceInfo: 'MacBook Air - Safari',
        ipAddress: getRandomItem(ipAddresses),
        userAgent: userAgents[1],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: true, // Revoked token
        deviceInfo: 'iPhone 14 - Safari',
        ipAddress: getRandomItem(ipAddresses),
        userAgent: userAgents[2],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generatePastDate(-10), // Expired 10 days ago
        isRevoked: false,
        deviceInfo: 'Pixel 8 Pro - Chrome',
        ipAddress: getRandomItem(ipAddresses),
        userAgent: userAgents[4],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: true, // Revoked token
        deviceInfo: 'Windows Laptop - Edge',
        ipAddress: getRandomItem(ipAddresses),
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(7),
        isRevoked: false,
        deviceInfo: 'iPad Pro - Safari',
        ipAddress: getRandomItem(ipAddresses),
        userAgent: userAgents[3],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: 'Samsung Tablet - Chrome',
        ipAddress: getRandomItem(ipAddresses),
        userAgent: userAgents[4],
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: getRandomItem(deviceInfos),
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: getRandomItem(deviceInfos),
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
      },
      {
        token: generateToken(),
        userId: getRandomItem(users).id,
        expiresAt: generateExpiresAt(30),
        isRevoked: false,
        deviceInfo: getRandomItem(deviceInfos),
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
      },
    ];

    for (const tokenData of refreshTokens) {
      const existing = await this.refreshTokenRepository.findOne({
        where: { token: tokenData.token },
      });

      if (!existing) {
        const refreshToken = this.refreshTokenRepository.create(tokenData);
        await this.refreshTokenRepository.save(refreshToken);
        const status = tokenData.isRevoked
          ? 'revoked'
          : new Date() > tokenData.expiresAt
            ? 'expired'
            : 'active';
        console.log(
          `✅ Created refresh token for user ${tokenData.userId} (${status})`,
        );
      } else {
        console.log(`⏭️  Refresh token already exists`);
      }
    }

    console.log('🎉 Refresh token seeding completed!');
  }
}
