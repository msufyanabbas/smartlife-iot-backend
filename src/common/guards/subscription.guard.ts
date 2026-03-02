// src/common/guards/subscription.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, SUBSCRIPTION_KEY } from '@decorators/index.decorator';
import { SubscriptionPlan, UserRole } from '@common/enums/index.enum';
import { SubscriptionsService } from '@modules/index.service';
import { Subscription } from '@modules/index.entities';

const PLAN_HIERARCHY: Record<SubscriptionPlan, number> = {
  [SubscriptionPlan.FREE]: 0,
  [SubscriptionPlan.STARTER]: 1,
  [SubscriptionPlan.PROFESSIONAL]: 2,
  [SubscriptionPlan.ENTERPRISE]: 3,
};

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private subscriptionsService: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
     const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin has no tenant and no subscription — always bypass
    if (user.role === UserRole.SUPER_ADMIN) return true;

    if (!user.tenantId) {
      throw new ForbiddenException('User is not associated with a tenant');
    }

    // ── Load & cache subscription ────────────────────────────────────────────
    // Always load the subscription regardless of whether @RequireSubscription()
    // is present, because FeatureLimitGuard and SubscriptionLimitGuard both
    // read req.subscription downstream. Without this, those guards fail silently
    // when @RequireSubscription() is not on the route.
    let subscription: Subscription = request.subscription;

    if (!subscription) {
      try {
        subscription = await this.subscriptionsService.findByTenantId(user.tenantId);
      } catch {
        throw new ForbiddenException(
          'No subscription found for this tenant. Please contact support.',
        );
      }
      // Cache on request — all downstream guards reuse this, zero extra DB calls
      request.subscription = subscription;
    }

    // ── Validate subscription health ─────────────────────────────────────────
    // Use entity methods — they handle edge cases like missing trialEndsAt
    if (!subscription.isActive()) {
      throw new ForbiddenException(
        'Your subscription is not active. Please renew to continue.',
      );
    }

    if (subscription.isTrialExpired()) {
      throw new ForbiddenException(
        'Your trial period has expired. Please upgrade your subscription.',
      );
    }

    // ── Check required plan level ─────────────────────────────────────────────
    const requiredPlans = this.reflector.getAllAndOverride<SubscriptionPlan[]>(
      SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @RequireSubscription() — being active is enough, pass through
    if (!requiredPlans || requiredPlans.length === 0) return true;

    const currentLevel = PLAN_HIERARCHY[subscription.plan] ?? 0;
    const minRequired = Math.min(...requiredPlans.map((p) => PLAN_HIERARCHY[p] ?? 0));

    if (currentLevel < minRequired) {
      const lowestRequired = requiredPlans.find(
        (p) => PLAN_HIERARCHY[p] === minRequired,
      );
      throw new ForbiddenException(
        `This feature requires the ${lowestRequired} plan or higher. ` +
        `Please upgrade your subscription.`,
      );
    }

    return true;
  }
}