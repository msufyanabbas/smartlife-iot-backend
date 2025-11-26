import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
} from '@modules/subscriptions/entities/subscription.entity';
import { Subscription, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SubscriptionSeeder implements ISeeder {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
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

    // Helper function to generate next billing date
    const generateNextBilling = (period: BillingPeriod): Date => {
      const date = new Date();
      if (period === BillingPeriod.MONTHLY) {
        date.setMonth(date.getMonth() + 1);
      } else {
        date.setFullYear(date.getFullYear() + 1);
      }
      return date;
    };

    // Helper function to generate trial end date
    const generateTrialEnd = (daysFromNow: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return date;
    };

    const subscriptions = [
      {
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 0,
        limits: {
          devices: 10,
          users: 2,
          apiCalls: 10000,
          dataRetention: 7,
          storage: 1,
        },
        usage: {
          devices: 5,
          users: 1,
          apiCalls: 3456,
          storage: 0.3,
        },
        features: {
          analytics: false,
          automation: false,
          integrations: false,
          support: 'community',
          whiteLabel: false,
        },
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 29.99,
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 100000,
          dataRetention: 30,
          storage: 10,
        },
        usage: {
          devices: 24,
          users: 3,
          apiCalls: 45678,
          storage: 4.2,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: false,
          support: 'email',
          whiteLabel: false,
        },
        nextBillingDate: generateNextBilling(BillingPeriod.MONTHLY),
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        price: 999.99,
        limits: {
          devices: 200,
          users: 20,
          apiCalls: 1000000,
          dataRetention: 90,
          storage: 50,
        },
        usage: {
          devices: 89,
          users: 12,
          apiCalls: 456789,
          storage: 28.5,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: true,
          support: 'priority',
          whiteLabel: false,
        },
        nextBillingDate: generateNextBilling(BillingPeriod.YEARLY),
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        plan: SubscriptionPlan.ENTERPRISE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        price: 4999.99,
        limits: {
          devices: -1, // Unlimited
          users: -1, // Unlimited
          apiCalls: -1, // Unlimited
          dataRetention: 365,
          storage: 500,
        },
        usage: {
          devices: 567,
          users: 45,
          apiCalls: 5678901,
          storage: 234.8,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: true,
          support: 'dedicated',
          whiteLabel: true,
        },
        nextBillingDate: generateNextBilling(BillingPeriod.YEARLY),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.TRIAL,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 29.99,
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 100000,
          dataRetention: 30,
          storage: 10,
        },
        usage: {
          devices: 8,
          users: 2,
          apiCalls: 12345,
          storage: 1.5,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: false,
          support: 'email',
          whiteLabel: false,
        },
        trialEndsAt: generateTrialEnd(7),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.TRIAL,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 99.99,
        limits: {
          devices: 200,
          users: 20,
          apiCalls: 1000000,
          dataRetention: 90,
          storage: 50,
        },
        usage: {
          devices: 15,
          users: 4,
          apiCalls: 34567,
          storage: 3.2,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: true,
          support: 'priority',
          whiteLabel: false,
        },
        trialEndsAt: generateTrialEnd(14),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.CANCELLED,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 29.99,
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 100000,
          dataRetention: 30,
          storage: 10,
        },
        usage: {
          devices: 18,
          users: 3,
          apiCalls: 23456,
          storage: 2.8,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: false,
          support: 'email',
          whiteLabel: false,
        },
        cancelledAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
        nextBillingDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // Billing until end of current period
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.EXPIRED,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 99.99,
        limits: {
          devices: 200,
          users: 20,
          apiCalls: 1000000,
          dataRetention: 90,
          storage: 50,
        },
        usage: {
          devices: 45,
          users: 8,
          apiCalls: 123456,
          storage: 12.5,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: true,
          support: 'priority',
          whiteLabel: false,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        price: 0,
        limits: {
          devices: 10,
          users: 2,
          apiCalls: 10000,
          dataRetention: 7,
          storage: 1,
        },
        usage: {
          devices: 9,
          users: 2,
          apiCalls: 8900,
          storage: 0.8,
        },
        features: {
          analytics: false,
          automation: false,
          integrations: false,
          support: 'community',
          whiteLabel: false,
        },
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        price: 299.99,
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 100000,
          dataRetention: 30,
          storage: 10,
        },
        usage: {
          devices: 32,
          users: 4,
          apiCalls: 67890,
          storage: 6.3,
        },
        features: {
          analytics: true,
          automation: true,
          integrations: false,
          support: 'email',
          whiteLabel: false,
        },
        nextBillingDate: generateNextBilling(BillingPeriod.YEARLY),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const subscriptionData of subscriptions) {
      const existing = await this.subscriptionRepository.findOne({
        where: { userId: subscriptionData.userId },
      });

      if (!existing) {
        const subscription =
          this.subscriptionRepository.create(subscriptionData);
        await this.subscriptionRepository.save(subscription);
        console.log(
          `✅ Created subscription: ${subscriptionData.plan} (${subscriptionData.status} - ${subscriptionData.billingPeriod})`,
        );
      } else {
        console.log(
          `⏭️  Subscription already exists for user ${subscriptionData.userId}`,
        );
      }
    }

    console.log('🎉 Subscription seeding completed!');
  }
}
