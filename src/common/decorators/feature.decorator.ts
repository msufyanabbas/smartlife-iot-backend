// src/common/decorators/feature.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { SubscriptionFeatures } from '@common/interfaces/index.interface';

export const FEATURE_KEY = 'feature';

/**
 * @RequireFeature()
 * Checks whether a subscription feature flag is enabled before allowing access.
 * Read by FeatureLimitGuard (global).
 * SubscriptionGuard must run first to cache req.subscription.
 *
 * Feature keys must match keys in SubscriptionFeatures interface exactly.
 * When a key is absent from existing subscription rows, it defaults to enabled
 * (fail-open behavior for new features added to the platform).
 *
 * @example
 * @RequireFeature('floorPlans')
 * @Post('floor-plans')
 * createFloorPlan() { ... }
 *
 * @RequireFeature('automations')
 * @Post('automations')
 * createAutomation() { ... }
 *
 * @RequireFeature('whiteLabel')
 * @Put('branding')
 * updateBranding() { ... }
 */
export const RequireFeature = (feature: keyof SubscriptionFeatures) =>
  SetMetadata(FEATURE_KEY, feature);