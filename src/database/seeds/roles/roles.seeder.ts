// src/database/seeds/role/role.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role, Permission, Tenant, Customer } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class RoleSeeder implements ISeeder {
  private readonly logger = new Logger(RoleSeeder.name);

  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting role seeding...');

    // Roles are NOT recreated when they already exist — an operator may have
    // edited them, and rewriting a live role's permission set would silently
    // revoke access. But a plain early return meant a newly added resource
    // (firmware) could never reach the roles on a database that had already
    // been seeded, so the role would exist without the new permissions and the
    // feature would 403 for everyone but SUPER_ADMIN / TENANT_ADMIN.
    //
    // So: top up the roles that should hold the new resource, then return.
    const existingRoles = await this.roleRepository.count();
    if (existingRoles > 0) {
      this.logger.log(
        `Roles already seeded (${existingRoles} records) — topping up new resources only.`,
      );
      await this.topUpNewResources();
      return;
    }

    // ========================================
    // FETCH EXISTING PERMISSIONS, TENANTS, CUSTOMERS
    // ========================================
    const allPermissions = await this.permissionRepository.find();
    const tenants = await this.tenantRepository.find({ take: 5 });
    const customers = await this.customerRepository.find({ take: 3 });

    if (allPermissions.length === 0) {
      this.logger.warn(
        '⚠️  No permissions found. Please seed permissions first. Skipping role seeding.',
      );
      return;
    }

    this.logger.log(`📊 Found ${allPermissions.length} permission(s)`);
    this.logger.log(`📊 Found ${tenants.length} tenant(s)`);
    this.logger.log(`📊 Found ${customers.length} customer(s)`);

    // ========================================
    // HELPER FUNCTIONS
    // ========================================
    const getPermissionsByResource = (resource: string): Permission[] => {
      return allPermissions.filter((p) => p.resource === resource);
    };

    const getPermissionsByAction = (action: string): Permission[] => {
      return allPermissions.filter((p) => p.action === action);
    };

    const getPermissionsByResourceAndActions = (
      resource: string,
      actions: string[],
    ): Permission[] => {
      return allPermissions.filter(
        (p) => p.resource === resource && actions.includes(p.action),
      );
    };

    const dedupePermissions = (permissions: Permission[]): Permission[] => {
      const seen = new Set<string>();
      return permissions.filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
    };

    // ========================================
    // SYSTEM ROLES DATA (8 roles)
    // ========================================
    const systemRoles = [
      // ========================================
      // SUPER ADMIN ROLE
      // ========================================
      {
        name: 'Super Administrator',
        description: 'Full system access with all permissions',
        isSystem: true,
        tenantId: null, // ✅ System role - no tenant
        permissions: allPermissions,
      },
      // ========================================
      // PLATFORM ADMINISTRATOR
      // ========================================
      {
        name: 'Platform Administrator',
        description:
          'Manages tenants, system settings, and platform-level operations',
        isSystem: true,
        tenantId: null,
        permissions: allPermissions.filter((p) =>
          [
            'tenants',
            'users',
            'roles',
            'permissions',
            'settings',
            'audit-logs',
            'billing',
          ].includes(p.resource),
        ),
      },
      // ========================================
      // DEVICE MANAGER
      // ========================================
      {
        name: 'Device Manager',
        description:
          'Manages all device-related operations and configurations',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('devices'),
          // Keeping a fleet patched is device management, so this role gets the
          // full firmware set including `assign` (starting a rollout).
          ...getPermissionsByResource('firmware'),
          ...getPermissionsByResourceAndActions('dashboards', [
            'read',
            'create',
          ]),
          ...getPermissionsByResourceAndActions('alerts', [
            'read',
            'create',
            'acknowledge',
          ]),
          ...getPermissionsByResourceAndActions('analytics', ['read']),
        ]),
      },
      // ========================================
      // DASHBOARD ADMINISTRATOR
      // ========================================
      {
        name: 'Dashboard Administrator',
        description: 'Creates and manages dashboards and visualizations',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('dashboards'),
          ...getPermissionsByResourceAndActions('devices', ['read', 'list']),
          ...getPermissionsByResourceAndActions('analytics', ['read', 'export']),
          ...getPermissionsByResourceAndActions('reports', [
            'read',
            'create',
            'export',
          ]),
        ]),
      },
      // ========================================
      // REPORT ANALYST
      // ========================================
      {
        name: 'Report Analyst',
        description: 'Generates and analyzes reports and analytics',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('reports'),
          ...getPermissionsByResource('analytics'),
          ...getPermissionsByResourceAndActions('dashboards', ['read']),
          ...getPermissionsByResourceAndActions('devices', ['read', 'list']),
          ...getPermissionsByResourceAndActions('customers', ['read', 'list']),
        ]),
      },
      // ========================================
      // ALERT MANAGER
      // ========================================
      {
        name: 'Alert Manager',
        description:
          'Manages alerts, notifications, and incident responses',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('alerts'),
          ...getPermissionsByResourceAndActions('devices', [
            'read',
            'list',
            'control',
          ]),
          ...getPermissionsByResourceAndActions('dashboards', ['read']),
          ...getPermissionsByResourceAndActions('reports', ['create', 'read']),
        ]),
      },
      // ========================================
      // SECURITY AUDITOR
      // ========================================
      {
        name: 'Security Auditor',
        description: 'Reviews audit logs and security-related activities',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('audit-logs'),
          ...getPermissionsByResourceAndActions('users', ['read', 'list']),
          ...getPermissionsByResourceAndActions('roles', ['read']),
          ...getPermissionsByResourceAndActions('permissions', ['read']),
          ...getPermissionsByResourceAndActions('settings', ['read']),
        ]),
      },
      // ========================================
      // READ-ONLY VIEWER
      // ========================================
      {
        name: 'Read-Only Viewer',
        description: 'View-only access to dashboards, devices, and reports',
        isSystem: true,
        tenantId: null,
        permissions: dedupePermissions([
          ...getPermissionsByAction('read'),
          ...getPermissionsByAction('list'),
        ]),
      },
    ];

    // ========================================
    // TENANT ROLES (2 roles) — scoped to first tenant
    // ========================================
    const tenantRoles: any[] = [];

    if (tenants.length > 0) {
      const firstTenant = tenants[0];

      tenantRoles.push(
        // ========================================
        // TENANT ADMINISTRATOR
        // ========================================
        {
          name: 'Tenant Administrator',
          description: `Full administrative access for ${firstTenant.name || 'this tenant'}`,
          isSystem: false, // ✅ Not a system role
          tenantId: firstTenant.id, // ✅ Scoped to tenant
          permissions: allPermissions.filter(
            (p) => !['tenants', 'billing'].includes(p.resource),
          ),
        },
        // ========================================
        // TENANT DEVICE OPERATOR
        // ========================================
        {
          name: 'Tenant Device Operator',
          description: 'Device operations for tenant users',
          isSystem: false,
          tenantId: firstTenant.id,
          permissions: dedupePermissions([
            ...getPermissionsByResourceAndActions('devices', [
              'read',
              'list',
              'control',
            ]),
            ...getPermissionsByResourceAndActions('dashboards', ['read']),
            ...getPermissionsByResourceAndActions('alerts', [
              'read',
              'acknowledge',
            ]),
          ]),
        },
      );
    }

    // ========================================
    // CUSTOMER ROLES (2 roles)
    // NOTE: Role entity does NOT have customerId field
    // Customer roles are tenant-scoped, not customer-scoped
    // ========================================
    const customerRoles: any[] = [];

    if (customers.length > 0 && tenants.length > 0) {
      const firstCustomer = customers[0];
      const customerTenant = tenants.find(t => t.id === firstCustomer.tenantId) || tenants[0];

      customerRoles.push(
        // ========================================
        // CUSTOMER ADMINISTRATOR
        // ========================================
        {
          name: 'Customer Administrator',
          description: `Administrative access for customers — manages users, devices, and dashboards within their account`,
          isSystem: false,
          tenantId: customerTenant.id, // ✅ Use tenant, not customer
          permissions: dedupePermissions([
            // Full CRUD on devices
            ...getPermissionsByResource('devices'),
            // Full CRUD on dashboards
            ...getPermissionsByResource('dashboards'),
            // Full CRUD on alerts
            ...getPermissionsByResource('alerts'),
            // Manage users
            ...getPermissionsByResourceAndActions('users', [
              'read',
              'list',
              'create',
              'update',
              'delete',
            ]),
            // Manage customer profile
            ...getPermissionsByResourceAndActions('customers', [
              'read',
              'update',
            ]),
            // View reports and analytics
            ...getPermissionsByResourceAndActions('reports', [
              'read',
              'create',
              'export',
            ]),
            ...getPermissionsByResourceAndActions('analytics', [
              'read',
              'export',
            ]),
            // Manage API keys
            ...getPermissionsByResourceAndActions('api-keys', [
              'read',
              'list',
              'create',
              'delete',
            ]),
          ]).filter(
            (p) =>
              !['tenants', 'billing', 'settings', 'audit-logs'].includes(
                p.resource,
              ),
          ),
        },
        // ========================================
        // CUSTOMER USER
        // ========================================
        {
          name: 'Customer User',
          description:
            'Standard end-user access — monitors devices, views dashboards, and manages their own alerts',
          isSystem: false,
          tenantId: customerTenant.id, // ✅ Use tenant, not customer
          permissions: dedupePermissions([
            // Read & control assigned devices
            ...getPermissionsByResourceAndActions('devices', [
              'read',
              'list',
              'control',
            ]),
            // View dashboards
            ...getPermissionsByResourceAndActions('dashboards', [
              'read',
              'list',
            ]),
            // Manage own alerts
            ...getPermissionsByResourceAndActions('alerts', [
              'read',
              'list',
              'acknowledge',
            ]),
            // View reports
            ...getPermissionsByResourceAndActions('reports', ['read', 'list']),
            // Basic analytics
            ...getPermissionsByResourceAndActions('analytics', ['read']),
          ]),
        },
      );
    }

    // ========================================
    // SEED ALL ROLES
    // ========================================
    const allRoles = [...systemRoles, ...tenantRoles, ...customerRoles];

    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const roleData of allRoles) {
      try {
        const existing = await this.roleRepository.findOne({
          where: {
            name: roleData.name,
            tenantId: roleData.tenantId ?? null, // ✅ Check both name AND tenantId
          },
        });

        if (!existing) {
          const role = this.roleRepository.create({
            name: roleData.name,
            description: roleData.description,
            isSystem: roleData.isSystem,
            tenantId: roleData.tenantId ?? null, // ✅ Use null for system roles
            permissions: roleData.permissions,
          });

          await this.roleRepository.save(role);

          const scopeLabel = roleData.tenantId
            ? `🏢 Tenant (${roleData.tenantId.substring(0, 8)}...)`
            : '🔧 System';

          this.logger.log(
            `✅ Created role: ${roleData.name.padEnd(35)} | ${scopeLabel} | ${roleData.permissions.length} permissions`,
          );
          createdCount++;
        } else {
          this.logger.log(`⏭️  Role already exists: ${roleData.name}`);
          existingCount++;
        }
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed role '${roleData.name}': ${error.message}`,
        );
        errorCount++;
      }
    }

    // ========================================
    // SUMMARY
    // ========================================
    const totalRoles =
      systemRoles.length + tenantRoles.length + customerRoles.length;

    this.logger.log('');
    this.logger.log('🎉 Role seeding completed!');
    this.logger.log(`   ✅ Roles created:        ${createdCount}`);
    this.logger.log(`   ⏭️  Roles already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors:               ${errorCount}`);
    }
    this.logger.log('');
    this.logger.log('📋 Role Distribution:');
    this.logger.log(`   🔧 System Roles:   ${systemRoles.length}`);
    this.logger.log(`   🏢 Tenant Roles:   ${tenantRoles.length}`);
    this.logger.log(`   👤 Customer Roles: ${customerRoles.length}`);
    this.logger.log(`   ─────────────────────`);
    this.logger.log(`   📦 Total:          ${totalRoles}`);
    this.logger.log('');
    this.logger.log('🔧 System Roles:');
    systemRoles.forEach((r) =>
      this.logger.log(`   - ${r.name} (${r.permissions.length} permissions)`),
    );
    if (tenantRoles.length > 0) {
      this.logger.log('');
      this.logger.log('🏢 Tenant Roles:');
      tenantRoles.forEach((r) =>
        this.logger.log(`   - ${r.name} (${r.permissions.length} permissions)`),
      );
    }
    if (customerRoles.length > 0) {
      this.logger.log('');
      this.logger.log('👤 Customer Roles (Tenant-scoped):');
      customerRoles.forEach((r) =>
        this.logger.log(`   - ${r.name} (${r.permissions.length} permissions)`),
      );
    }
  }

  /**
   * Grant newly-introduced permission resources to the roles that should hold
   * them, on a database whose roles were seeded before those permissions
   * existed.
   *
   * Additive only — it never removes a permission, so an operator who
   * deliberately narrowed a role keeps their change for everything except the
   * new resource. Re-running it is a no-op.
   *
   * The grant rules mirror how the roles were defined above:
   *   Super Administrator  → everything
   *   Read-Only Viewer     → read + list actions only
   *   Device Manager       → the whole resource (patching is device management)
   *   Tenant Administrator → everything except tenants/billing
   */
  private async topUpNewResources(): Promise<void> {
    const NEW_RESOURCES = ['firmware'];

    const newPermissions = await this.permissionRepository.find({
      where: NEW_RESOURCES.map((resource) => ({ resource })),
    });
    if (newPermissions.length === 0) {
      this.logger.warn(
        `No permissions found for [${NEW_RESOURCES.join(', ')}] — run the permission seeder first.`,
      );
      return;
    }

    const readOnly = newPermissions.filter((p) =>
      ['read', 'list'].includes(p.action),
    );

    const grantsByRoleName: Record<string, Permission[]> = {
      'Super Administrator': newPermissions,
      'Platform Administrator': newPermissions,
      'Device Manager': newPermissions,
      'Tenant Administrator': newPermissions,
      'Customer Administrator': newPermissions,
      'Read-Only Viewer': readOnly,
      'Tenant Device Operator': readOnly,
      'Customer User': readOnly,
    };

    let updated = 0;

    for (const [roleName, grants] of Object.entries(grantsByRoleName)) {
      if (grants.length === 0) continue;

      // `find`, not `findOne` — role names are unique per tenant, not globally,
      // so 'Tenant Administrator' legitimately exists once per tenant and all
      // of them need the same top-up.
      const roles = await this.roleRepository.find({
        where: { name: roleName },
        relations: ['permissions'],
      });

      for (const role of roles) {
        const held = new Set((role.permissions ?? []).map((p) => p.id));
        const missing = grants.filter((p) => !held.has(p.id));
        if (missing.length === 0) continue;

        role.permissions = [...(role.permissions ?? []), ...missing];
        await this.roleRepository.save(role);
        this.logger.log(
          `   + ${roleName}${role.tenantId ? ` (tenant ${role.tenantId.slice(0, 8)})` : ''}: granted ${missing
            .map((p) => p.permissionString)
            .join(', ')}`,
        );
        updated++;
      }
    }

    this.logger.log(
      updated > 0
        ? `Topped up ${updated} role(s) with [${NEW_RESOURCES.join(', ')}] permissions.`
        : `All roles already hold the [${NEW_RESOURCES.join(', ')}] permissions.`,
    );
  }
}
