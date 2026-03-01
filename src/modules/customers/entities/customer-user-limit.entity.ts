// src/modules/customers/entities/customer-user-limit.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Customer } from '@modules/index.entities';

// ─────────────────────────────────────────────────────────────────────────────
// CustomerUserLimit
//
// Stores the resource quota a customer admin assigns to a specific user
// within their customer. This is Layer 3 of the quota system:
//
//   Layer 1: Subscription.limits         → tenant ceiling (e.g. devices=50)
//   Layer 2: Customer.allocatedLimits    → customer slice (e.g. devices=20)
//   Layer 3: CustomerUserLimit.limits    → user slice     (e.g. devices=5)
//
// Rules:
//   - Sum of all user limits in a customer cannot exceed Customer.allocatedLimits
//   - All user limits must be <= Customer.allocatedLimits
//   - This record is created/updated when customer admin sets per-user limits
//   - If no record exists for a user, they share from the customer pool freely
//     (bounded by customer.allocatedLimits only)
// ─────────────────────────────────────────────────────────────────────────────

@Entity('customer_user_limits')
@Unique(['userId', 'customerId']) // one limit record per user per customer
@Index(['customerId'])
@Index(['tenantId'])
export class CustomerUserLimit extends BaseEntity {
  // ── Relationships ─────────────────────────────────────────────────────────
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  // Denormalized for faster queries (avoids joining through customer every time)
  @Column()
  @Index()
  tenantId: string;

  // ── Allocated Limits ──────────────────────────────────────────────────────
  // Set by customer admin. Each value must be <= Customer.allocatedLimits[resource].
  // null on any field = no user-level cap for that resource.
  @Column({ type: 'jsonb', default: '{}' })
  limits: {
    devices?: number;
    dashboards?: number;
    assets?: number;
    floorPlans?: number;
    automations?: number;
  };

  // ── Usage Counters ────────────────────────────────────────────────────────
  // How many of each resource are currently assigned to this user.
  // Incremented when a resource is assigned to the user.
  // Decremented when a resource is unassigned or deleted.
  @Column({ type: 'jsonb', default: '{"devices":0,"dashboards":0,"assets":0,"floorPlans":0,"automations":0}' })
  usageCounters: {
    devices: number;
    dashboards: number;
    assets: number;
    floorPlans: number;
    automations: number;
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  hasReachedLimit(resource: keyof CustomerUserLimit['limits']): boolean {
    const limit = this.limits?.[resource];
    if (limit === undefined || limit === null) return false; // no user-level cap
    return (this.usageCounters?.[resource] ?? 0) >= limit;
  }

  getRemainingCapacity(resource: keyof CustomerUserLimit['limits']): number {
    const limit = this.limits?.[resource];
    if (limit === undefined || limit === null) return Infinity;
    return Math.max(0, limit - (this.usageCounters?.[resource] ?? 0));
  }
}