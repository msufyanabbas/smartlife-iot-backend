// src/modules/assignments/entities/resource-assignment.entities.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// RESOURCE ASSIGNMENT ENTITIES
//
// These junction tables track which resources (devices, dashboards, assets, etc.)
// are assigned to which customers and users.
//
// WHY TWO LEVELS (customer + user)?
//
//   Customer level: Tenant admin assigns Device-1 to Customer A.
//     → All users in Customer A can now interact with Device-1
//       (subject to their own permissions).
//     → This increments Customer.usageCounters.devices
//
//   User level: Customer admin assigns Device-1 to User X within Customer A.
//     → User X gets direct visibility of Device-1 in their personal scope.
//     → This increments CustomerUserLimit.usageCounters.devices
//     → User X must belong to Customer A (enforced at service layer).
//     → Device-1 must already be assigned to Customer A (enforced at service layer).
//
// PERMISSION GATE RULE:
//   Before ANY assignment, the target (customer or user) must have the
//   relevant permission for that resource type. If Customer A has no
//   'devices:*' permission → no devices can be assigned to Customer A or
//   any of its users, regardless of quota.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  CreateDateColumn,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Asset, Automation, Customer, Dashboard, Device, FloorPlan, User, Tenant } from '@modules/index.entities';

// ─────────────────────────────────────────────────────────────────────────────
// Base class for all customer-level resource assignments
// ─────────────────────────────────────────────────────────────────────────────
abstract class CustomerResourceAssignment extends BaseEntity {
  @Column()

  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  // Denormalized for fast tenant-scoped queries
  @Column()

  tenantId: string;

  // When was this resource assigned to this customer
  @CreateDateColumn()

  assignedAt: Date;

  // Who assigned it (tenant admin's userId)
  @Column({ nullable: true })

  assignedBy?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'assignedBy' })
  assignor?: User;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base class for all user-level resource assignments
// ─────────────────────────────────────────────────────────────────────────────
abstract class UserResourceAssignment extends BaseEntity {
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

  // Denormalized for fast tenant-scoped queries
  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @CreateDateColumn()

  assignedAt: Date;

  // Who assigned it (customer admin's userId)
  @Column({ nullable: true })

  assignedBy?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'assignedBy' })
  assignor?: User;
}

// ═════════════════════════════════════════════════════════════════════════════
// DEVICE ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

@Entity('customer_devices')
@Unique(['customerId', 'deviceId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'deviceId'])
export class CustomerDevice extends CustomerResourceAssignment {
  @Column()

  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;
}

@Entity('user_devices')
@Unique(['userId', 'deviceId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'userId'])
@Index(['customerId', 'deviceId'])
export class UserDevice extends UserResourceAssignment {
  @Column()

  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  // Constraint: deviceId must already exist in customer_devices for this customerId.
  // Enforced at service layer, not DB level (too complex for a DB constraint).
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

@Entity('customer_dashboards')
@Unique(['customerId', 'dashboardId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'dashboardId'])
export class CustomerDashboard extends CustomerResourceAssignment {
  @Column()

  dashboardId: string;

  @ManyToOne(() => Dashboard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dashboardId' })
  dashboard: Dashboard;
}

@Entity('user_dashboards')
@Unique(['userId', 'dashboardId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'userId'])
@Index(['customerId', 'dashboardId'])
export class UserDashboard extends UserResourceAssignment {
  @Column()

  dashboardId: string;

  @ManyToOne(() => Dashboard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dashboardId' })
  dashboard: Dashboard;

  // Constraint: dashboardId must already exist in customer_dashboards for this customerId.
  // Enforced at service layer, not DB level (too complex for a DB constraint).
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSET ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

@Entity('customer_assets')
@Unique(['customerId', 'assetId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'assetId'])
export class CustomerAsset extends CustomerResourceAssignment {
  @Column()

  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assetId' })
  asset: Asset;
}

@Entity('user_assets')
@Unique(['userId', 'assetId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'userId'])
@Index(['customerId', 'assetId'])
export class UserAsset extends UserResourceAssignment {
  @Column()

  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assetId' })
  asset: Asset;

  // Constraint: assetId must already exist in customer_assets for this customerId.
  // Enforced at service layer, not DB level (too complex for a DB constraint).
}

// ═════════════════════════════════════════════════════════════════════════════
// FLOOR PLAN ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

@Entity('customer_floor_plans')
@Unique(['customerId', 'floorPlanId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'floorPlanId'])
export class CustomerFloorPlan extends CustomerResourceAssignment {
  @Column()

  floorPlanId: string;

  @ManyToOne(() => FloorPlan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'floorPlanId' })
  floorPlan: FloorPlan;
}

@Entity('user_floor_plans')
@Unique(['userId', 'floorPlanId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'userId'])
@Index(['customerId', 'floorPlanId'])
export class UserFloorPlan extends UserResourceAssignment {
  @Column()

  floorPlanId: string;

  @ManyToOne(() => FloorPlan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'floorPlanId' })
  floorPlan: FloorPlan;

  // Constraint: floorPlanId must already exist in customer_floor_plans for this customerId.
  // Enforced at service layer, not DB level (too complex for a DB constraint).
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATION ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

@Entity('customer_automations')
@Unique(['customerId', 'automationId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'automationId'])
export class CustomerAutomation extends CustomerResourceAssignment {
  @Column()

  automationId: string;

  @ManyToOne(() => Automation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'automationId' })
  automation: Automation;
}

@Entity('user_automations')
@Unique(['userId', 'automationId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'userId'])
@Index(['customerId', 'automationId'])
export class UserAutomation extends UserResourceAssignment {
  @Column()

  automationId: string;

  @ManyToOne(() => Automation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'automationId' })
  automation: Automation;

  // Constraint: automationId must already exist in customer_automations for this customerId.
  // Enforced at service layer, not DB level (too complex for a DB constraint).
}