// src/common/guards/subscription.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SUBSCRIPTION_KEY } from '@decorators/subscription.decorator';
import { SubscriptionPlan, SubscriptionStatus } from '@common/enums/index.enum';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private subscriptionsService: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPlans = this.reflector.getAllAndOverride<SubscriptionPlan[]>(
      SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no subscription requirement, allow access
    if (!requiredPlans || requiredPlans.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    try {
      const subscription = await this.subscriptionsService.findCurrent(user.id);

      // Check if subscription is active or in trial
      if (
        subscription.status !== SubscriptionStatus.ACTIVE &&
        subscription.status !== SubscriptionStatus.TRIAL
      ) {
        throw new ForbiddenException(
          'Your subscription is not active. Please renew your subscription.',
        );
      }

      // Check if trial has expired
      if (
        subscription.status === SubscriptionStatus.TRIAL &&
        subscription.trialEndsAt &&
        new Date() > subscription.trialEndsAt
      ) {
        throw new ForbiddenException(
          'Your trial period has expired. Please upgrade your subscription.',
        );
      }

      // Define plan hierarchy
      const planHierarchy = {
        [SubscriptionPlan.FREE]: 0,
        [SubscriptionPlan.STARTER]: 1,
        [SubscriptionPlan.PROFESSIONAL]: 2,
        [SubscriptionPlan.ENTERPRISE]: 3,
      };

      const userPlanLevel = planHierarchy[subscription.plan];
      const minRequiredLevel = Math.min(
        ...requiredPlans.map((plan) => planHierarchy[plan]),
      );

      if (userPlanLevel < minRequiredLevel) {
        throw new ForbiddenException(
          `This feature requires at least ${requiredPlans[0]} plan. Please upgrade your subscription.`,
        );
      }

      // Attach subscription to request for further use
      context.switchToHttp().getRequest().subscription = subscription;

      return true;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ForbiddenException(
          'No active subscription found. Please subscribe to a plan.',
        );
      }
      throw error;
    }
  }
}