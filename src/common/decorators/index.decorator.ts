// src/common/decorators/index.ts
//
// Single barrel export for all decorators.
// Import everything from here — never import from individual decorator files
// directly in feature modules, to keep refactoring easy.
//
// Rule: each constant/decorator is defined in EXACTLY ONE file.
// This barrel re-exports everything. No two files define the same export.
//

// ── Access control composition decorators ─────────────────────────────────────
export * from './access-control.decorator';

// ── Audit decorator ────────────────────────────────────────────────────────────
export * from './audit.decorator';

// ── Param decorators (CurrentUser, ResolvedTenantId, ResolvedCustomerId) ───────
// Also exports the Express Request augmentation (declare global namespace)
export * from './current-user.decorator';

// ── Feature flag decorator (RequireFeature, FEATURE_KEY) ──────────────────────
export * from './feature.decorator';

// ── Notification decorator ────────────────────────────────────────────────────
export * from './notify.decorator';

// ── Permission decorator (RequirePermissions, PERMISSIONS_KEY) ────────────────
export * from './permission.decorator';

// ── Phone validation decorator (IsValidPhone) ─────────────────────────────────
export * from './phone-validator.decorator';

// ── Public route decorator (Public, IS_PUBLIC_KEY) ────────────────────────────
export * from './public.decorator';

// ── Roles decorator (Roles, ROLES_KEY) ────────────────────────────────────────
export * from './roles.decorator';

// ── Subscription decorators (RequireSubscription, RequireSubscriptionLimit) ────
export * from './subscription.decorator';