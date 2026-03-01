// src/modules/customers/entities/customer.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany, JoinTable, ManyToMany } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Permission, Tenant, User } from '@modules/index.entities';
import { CustomerStatus } from '@common/enums/index.enum';
@Entity('customers')
@Index(['tenantId', 'status'])
export class Customer extends BaseEntity {
  @Column({ nullable: true})
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ nullable: true })
  country?: string;

  @Column({ nullable: true })
  state?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true })
  zip?: string;

  @Column({ type: 'enum', enum: CustomerStatus, default: CustomerStatus.ACTIVE })
  status: CustomerStatus;

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.customers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @OneToMany(() => User, (user) => user.customer)
  users?: User[];

  // ── Quota Allocation ──────────────────────────────────────────────────────
  // Set by the tenant admin when creating/editing this customer.
  // These are the MAXIMUM numbers this customer is allowed across all their users.
  // All values must be <= the tenant's subscription limits.
  // null on any field = no customer-level cap (falls back to subscription limit).
  @Column({ type: 'jsonb', default: '{}' })
  allocatedLimits: {
    devices?: number;
    dashboards?: number;
    assets?: number;
    floorPlans?: number;
    automations?: number;
    users?: number;
  };

  // ── Usage Counters ────────────────────────────────────────────────────────
  // Incremented/decremented by the service layer — never use COUNT(*) in guards.
  // Tracks how many resources are currently assigned to / created under this customer.
  @Column({ type: 'jsonb', default: '{"devices":0,"dashboards":0,"assets":0,"floorPlans":0,"automations":0,"users":0}' })
  usageCounters: {
    devices: number;
    dashboards: number;
    assets: number;
    floorPlans: number;
    automations: number;
    users: number;
  };

  // ── Permission Grants ─────────────────────────────────────────────────────
  // The tenant admin explicitly grants permissions to this customer.
  // These become the CEILING for everything under this customer.
  // A customer user can NEVER have a permission not in this set.
  // Also: if a resource has no permission here, that resource CANNOT be assigned
  // to this customer at all (gate check happens in assignment service).
  @ManyToMany(() => Permission, { eager: true })
  @JoinTable({
    name: 'customer_permissions',
    joinColumn: { name: 'customerId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  grantedPermissions?: Permission[];

  // ── Helpers ───────────────────────────────────────────────────────────────
  isActive(): boolean {
    return this.status === CustomerStatus.ACTIVE;
  }

  belongsToTenant(tenantId: string): boolean {
    return this.tenantId === tenantId;
  }

  getFullAddress(): string {
    const parts = [this.address, this.city, this.state, this.zip, this.country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : 'No address provided';
  }

  // Check if customer has permission for a resource (e.g. 'devices')
  hasResourcePermission(resource: string): boolean {
    return (this.grantedPermissions ?? []).some((p) => p.resource === resource);
  }

  // Check if customer has reached their allocated limit for a resource
  hasReachedLimit(resource: keyof Customer['allocatedLimits']): boolean {
    const limit = this.allocatedLimits?.[resource];
    if (limit === undefined || limit === null) return false;
    return (this.usageCounters?.[resource] ?? 0) >= limit;
  }
}