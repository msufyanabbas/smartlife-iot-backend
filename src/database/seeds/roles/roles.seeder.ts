import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Role } from '@modules/roles/entities/roles.entity';
import { Permission } from '@modules/permissions/entities/permissions.entity';
import { Tenant } from '@modules/index.entities';
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
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting role seeding...');

    // ========================================
    // FETCH EXISTING PERMISSIONS AND TENANTS
    // ========================================
    const allPermissions = await this.permissionRepository.find();
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (allPermissions.length === 0) {
      this.logger.warn(
        '⚠️  No permissions found. Please seed permissions first. Skipping role seeding.',
      );
      return;
    }

    this.logger.log(`📊 Found ${allPermissions.length} permission(s)`);
    this.logger.log(`📊 Found ${tenants.length} tenant(s)`);

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

    // ========================================
    // SYSTEM ROLES DATA
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
        permissions: allPermissions, // All permissions
      },

      // ========================================
      // PLATFORM ADMINISTRATOR
      // ========================================
      {
        name: 'Platform Administrator',
        description: 'Manages tenants, system settings, and platform-level operations',
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
        description: 'Manages all device-related operations and configurations',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('devices'),
          ...getPermissionsByResourceAndActions('dashboards', ['read', 'create']),
          ...getPermissionsByResourceAndActions('alerts', ['read', 'create', 'acknowledge']),
          ...getPermissionsByResourceAndActions('analytics', ['read']),
        ],
      },

      // ========================================
      // CUSTOMER MANAGER
      // ========================================
      {
        name: 'Customer Manager',
        description: 'Manages customer accounts and relationships',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('customers'),
          ...getPermissionsByResourceAndActions('users', ['read', 'list']),
          ...getPermissionsByResourceAndActions('dashboards', ['read']),
          ...getPermissionsByResourceAndActions('reports', ['read']),
        ],
      },

      // ========================================
      // DASHBOARD ADMINISTRATOR
      // ========================================
      {
        name: 'Dashboard Administrator',
        description: 'Creates and manages dashboards and visualizations',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('dashboards'),
          ...getPermissionsByResourceAndActions('devices', ['read', 'list']),
          ...getPermissionsByResourceAndActions('analytics', ['read', 'export']),
          ...getPermissionsByResourceAndActions('reports', ['read', 'create', 'export']),
        ],
      },

      // ========================================
      // REPORT ANALYST
      // ========================================
      {
        name: 'Report Analyst',
        description: 'Generates and analyzes reports and analytics',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('reports'),
          ...getPermissionsByResource('analytics'),
          ...getPermissionsByResourceAndActions('dashboards', ['read']),
          ...getPermissionsByResourceAndActions('devices', ['read', 'list']),
          ...getPermissionsByResourceAndActions('customers', ['read', 'list']),
        ],
      },

      // ========================================
      // ALERT MANAGER
      // ========================================
      {
        name: 'Alert Manager',
        description: 'Manages alerts, notifications, and incident responses',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('alerts'),
          ...getPermissionsByResourceAndActions('devices', ['read', 'list', 'control']),
          ...getPermissionsByResourceAndActions('dashboards', ['read']),
          ...getPermissionsByResourceAndActions('reports', ['create', 'read']),
        ],
      },

      // ========================================
      // READ-ONLY VIEWER
      // ========================================
      {
        name: 'Read-Only Viewer',
        description: 'View-only access to dashboards, devices, and reports',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByAction('read'),
          ...getPermissionsByAction('list'),
        ],
      },

      // ========================================
      // USER ADMINISTRATOR
      // ========================================
      {
        name: 'User Administrator',
        description: 'Manages user accounts, roles, and permissions',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('users'),
          ...getPermissionsByResource('roles'),
          ...getPermissionsByResourceAndActions('permissions', ['read', 'list']),
          ...getPermissionsByResourceAndActions('customers', ['read', 'list']),
          ...getPermissionsByResourceAndActions('tenants', ['read', 'list']),
        ],
      },

      // ========================================
      // API ADMINISTRATOR
      // ========================================
      {
        name: 'API Administrator',
        description: 'Manages API keys and integrations',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('api-keys'),
          ...getPermissionsByResourceAndActions('settings', ['read', 'update']),
          ...getPermissionsByResourceAndActions('audit-logs', ['read']),
        ],
      },

      // ========================================
      // BILLING ADMINISTRATOR
      // ========================================
      {
        name: 'Billing Administrator',
        description: 'Manages billing, subscriptions, and financial operations',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('billing'),
          ...getPermissionsByResourceAndActions('customers', ['read', 'list']),
          ...getPermissionsByResourceAndActions('tenants', ['read', 'list']),
          ...getPermissionsByResourceAndActions('reports', ['read', 'create', 'export']),
        ],
      },

      // ========================================
      // SECURITY AUDITOR
      // ========================================
      {
        name: 'Security Auditor',
        description: 'Reviews audit logs and security-related activities',
        isSystem: true,
        tenantId: null,
        permissions: [
          ...getPermissionsByResource('audit-logs'),
          ...getPermissionsByResourceAndActions('users', ['read', 'list']),
          ...getPermissionsByResourceAndActions('roles', ['read']),
          ...getPermissionsByResourceAndActions('permissions', ['read']),
          ...getPermissionsByResourceAndActions('settings', ['read']),
        ],
      },
    ];

    // ========================================
    // TENANT-SPECIFIC ROLES (if tenants exist)
    // ========================================
    const tenantRoles: any[] = [];

    if (tenants.length > 0) {
      // Create tenant-specific roles for the first tenant as examples
      const firstTenant = tenants[0];

      tenantRoles.push(
        {
          name: 'Tenant Administrator',
          description: `Full administrative access for ${firstTenant.name || 'this tenant'}`,
          isSystem: false,
          tenantId: firstTenant.id,
          permissions: allPermissions.filter(
            (p) => !['tenants', 'billing'].includes(p.resource),
          ),
        },
        {
          name: 'Tenant Device Operator',
          description: 'Device operations for tenant users',
          isSystem: false,
          tenantId: firstTenant.id,
          permissions: [
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
          ],
        },
        {
          name: 'Tenant Viewer',
          description: 'Read-only access for tenant users',
          isSystem: false,
          tenantId: firstTenant.id,
          permissions: [
            ...getPermissionsByAction('read'),
            ...getPermissionsByAction('list'),
          ].filter((p) => !['tenants', 'billing', 'settings'].includes(p.resource)),
        },
      );
    }

    // ========================================
    // SEED ROLES
    // ========================================
    const allRoles = [...systemRoles, ...tenantRoles];
    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const roleData of allRoles) {
      try {
        const existing = await this.roleRepository.findOne({
          where: {
            name: roleData.name,
            tenantId: roleData.tenantId || null,
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

          const roleType = roleData.tenantId ? '🏢 Tenant' : '🔧 System';
          const permCount = roleData.permissions.length;

          this.logger.log(
            `✅ Created role: ${roleData.name.padEnd(35)} | ${roleType} | ${permCount} permissions`,
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
    this.logger.log('🎉 Role seeding completed!');
    this.logger.log(`   ✅ Roles created: ${createdCount}`);
    this.logger.log(`   ⏭️  Roles already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
    this.logger.log('');
    this.logger.log('📋 Role Distribution:');
    this.logger.log(
      `   - System Roles: ${systemRoles.length}`,
    );
    this.logger.log(
      `   - Tenant Roles: ${tenantRoles.length}`,
    );
    this.logger.log('');
    this.logger.log('🔑 System Roles Created:');
    systemRoles.forEach((role) => {
      this.logger.log(
        `   - ${role.name} (${role.permissions.length} permissions)`,
      );
    });

    if (tenantRoles.length > 0) {
      this.logger.log('');
      this.logger.log('🏢 Tenant-Specific Roles Created:');
      tenantRoles.forEach((role) => {
        this.logger.log(
          `   - ${role.name} (${role.permissions.length} permissions)`,
        );
      });
    }
  }
}