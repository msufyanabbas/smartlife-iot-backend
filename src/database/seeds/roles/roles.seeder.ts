import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Role } from '@modules/roles/entities/roles.entity';
import { Permission } from '@modules/permissions/entities/permissions.entity';
import { Tenant } from '@modules/index.entities';
import { Customer } from '@modules/customers/entities/customers.entity'; // adjust path
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
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting role seeding...');

    // ========================================
    // FETCH EXISTING PERMISSIONS, TENANTS, CUSTOMERS
    // ========================================
    const allPermissions = await this.permissionRepository.find();
    const tenants = await this.tenantRepository.find({ take: 5 });
    const customers = await this.customerRepository.find({ take: 3 });

    if (allPermissions.length === 0) {
      this.logger.warn(
        '⚠️ No permissions found. Please seed permissions first. Skipping role seeding.',
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

    const getPermissionsByResources = (resources: string[]): Permission[] => {
      return allPermissions.filter((p) => resources.includes(p.resource));
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
        tenantId: null,
        customerId: null,
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
        customerId: null,
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
        customerId: null,
        permissions: dedupePermissions([
          ...getPermissionsByResource('devices'),
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
        customerId: null,
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
        customerId: null,
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
        customerId: null,
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
        customerId: null,
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
        customerId: null,
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
          isSystem: false,
          tenantId: firstTenant.id,
          customerId: null,
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
          customerId: null,
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
    // CUSTOMER ROLES (2 roles) — scoped to first customer
    // ========================================
    const customerRoles: any[] = [];

    if (customers.length > 0) {
      const firstCustomer = customers[0];

      customerRoles.push(
        // ========================================
        // CUSTOMER ADMINISTRATOR
        // ========================================
        {
          name: 'Customer Administrator',
          description: `Administrative access for ${firstCustomer.name || 'this customer'} — manages users, devices, and dashboards within their account`,
          isSystem: false,
          tenantId: firstCustomer.tenantId ?? null,
          customerId: firstCustomer.id,
          permissions: dedupePermissions([
            // Full CRUD on their own devices
            ...getPermissionsByResource('devices'),
            // Full CRUD on dashboards
            ...getPermissionsByResource('dashboards'),
            // Full CRUD on alerts
            ...getPermissionsByResource('alerts'),
            // Manage users within their customer scope
            ...getPermissionsByResourceAndActions('users', [
              'read',
              'list',
              'create',
              'update',
              'delete',
            ]),
            // Manage their own customer profile
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
            // View API keys (no system-level resources)
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
          tenantId: firstCustomer.tenantId ?? null,
          customerId: firstCustomer.id,
          permissions: dedupePermissions([
            // Read & control their assigned devices (no create/delete)
            ...getPermissionsByResourceAndActions('devices', [
              'read',
              'list',
              'control',
            ]),
            // View dashboards only
            ...getPermissionsByResourceAndActions('dashboards', [
              'read',
              'list',
            ]),
            // Manage their own alerts (acknowledge, read)
            ...getPermissionsByResourceAndActions('alerts', [
              'read',
              'list',
              'acknowledge',
            ]),
            // View reports
            ...getPermissionsByResourceAndActions('reports', ['read', 'list']),
            // Basic analytics read
            ...getPermissionsByResourceAndActions('analytics', ['read']),
          ]),
        },
      );
    } else {
      // ========================================
      // FALLBACK: Seed customer roles without a customerId
      // so they're available as role templates even before
      // any customers exist.
      // ========================================
      this.logger.warn(
        '⚠️ No customers found. Seeding customer role templates without customerId.',
      );

      customerRoles.push(
        {
          name: 'Customer Administrator',
          description:
            'Administrative access — manages users, devices, and dashboards within their account',
          isSystem: true, // template — not scoped to a customer yet
          tenantId: null,
          customerId: null,
          permissions: dedupePermissions([
            ...getPermissionsByResource('devices'),
            ...getPermissionsByResource('dashboards'),
            ...getPermissionsByResource('alerts'),
            ...getPermissionsByResourceAndActions('users', [
              'read',
              'list',
              'create',
              'update',
              'delete',
            ]),
            ...getPermissionsByResourceAndActions('customers', [
              'read',
              'update',
            ]),
            ...getPermissionsByResourceAndActions('reports', [
              'read',
              'create',
              'export',
            ]),
            ...getPermissionsByResourceAndActions('analytics', [
              'read',
              'export',
            ]),
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
        {
          name: 'Customer User',
          description:
            'Standard end-user access — monitors devices, views dashboards, and manages their own alerts',
          isSystem: true, // template — not scoped to a customer yet
          tenantId: null,
          customerId: null,
          permissions: dedupePermissions([
            ...getPermissionsByResourceAndActions('devices', [
              'read',
              'list',
              'control',
            ]),
            ...getPermissionsByResourceAndActions('dashboards', [
              'read',
              'list',
            ]),
            ...getPermissionsByResourceAndActions('alerts', [
              'read',
              'list',
              'acknowledge',
            ]),
            ...getPermissionsByResourceAndActions('reports', ['read', 'list']),
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
            tenantId: roleData.tenantId ?? null,
          },
        });

        if (!existing) {
          const role = this.roleRepository.create({
            name: roleData.name,
            description: roleData.description,
            isSystem: roleData.isSystem,
            tenantId: roleData.tenantId,
            permissions: roleData.permissions,
          });

          await this.roleRepository.save(role);

          const scopeLabel = roleData.customerId
            ? '👤 Customer'
            : roleData.tenantId
              ? '🏢 Tenant'
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
          `❌ Failed to seed role ${roleData.name}: ${error.message}`,
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
      this.logger.log('👤 Customer Roles:');
      customerRoles.forEach((r) =>
        this.logger.log(`   - ${r.name} (${r.permissions.length} permissions)`),
      );
    }
  }
}