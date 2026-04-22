// src/database/seeds/permission/permission.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class PermissionSeeder implements ISeeder {
  private readonly logger = new Logger(PermissionSeeder.name);

  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting permission seeding...');

    // Check if permissions already exist
    const existingPermissions = await this.permissionRepository.count();
    if (existingPermissions > 0) {
      this.logger.log(
        `⏭️  Permissions already seeded (${existingPermissions} records). Skipping...`,
      );
      return;
    }

    // ════════════════════════════════════════════════════════════════
    // SYSTEM PERMISSIONS (tenantId = null, isSystem = true)
    // Available to all tenants
    // ════════════════════════════════════════════════════════════════
    const systemPermissions = [
      // ════════════════════════════════════════════════════════════════
      // DEVICE PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'devices',
        action: 'create',
        description: 'Create new devices in the system',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'devices',
        action: 'read',
        description: 'View device information and details',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'devices',
        action: 'update',
        description: 'Update device configuration and settings',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'devices',
        action: 'delete',
        description: 'Remove devices from the system',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'devices',
        action: 'list',
        description: 'List all devices with filtering and pagination',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'devices',
        action: 'control',
        description: 'Send commands and control device operations',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // CUSTOMER PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'customers',
        action: 'create',
        description: 'Create new customer accounts',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'customers',
        action: 'read',
        description: 'View customer information',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'customers',
        action: 'update',
        description: 'Update customer details and settings',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'customers',
        action: 'delete',
        description: 'Remove customer accounts',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'customers',
        action: 'list',
        description: 'List all customers',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // TENANT PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'tenants',
        action: 'create',
        description: 'Create new tenant organizations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'tenants',
        action: 'read',
        description: 'View tenant information',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'tenants',
        action: 'update',
        description: 'Update tenant configuration',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'tenants',
        action: 'delete',
        description: 'Remove tenant organizations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'tenants',
        action: 'list',
        description: 'List all tenants',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // USER PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'users',
        action: 'create',
        description: 'Create new user accounts',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'users',
        action: 'read',
        description: 'View user profiles and information',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'users',
        action: 'update',
        description: 'Update user details and settings',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'users',
        action: 'delete',
        description: 'Remove user accounts',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'users',
        action: 'list',
        description: 'List all users',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'users',
        action: 'manage-roles',
        description: 'Assign and manage user roles',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // DASHBOARD PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'dashboards',
        action: 'create',
        description: 'Create custom dashboards',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'dashboards',
        action: 'read',
        description: 'View dashboards and analytics',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'dashboards',
        action: 'update',
        description: 'Modify dashboard configuration',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'dashboards',
        action: 'delete',
        description: 'Remove dashboards',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'dashboards',
        action: 'list',
        description: 'List all dashboards',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'dashboards',
        action: 'share',
        description: 'Share dashboards with other users',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // ASSET PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'assets',
        action: 'create',
        description: 'Create new assets',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'assets',
        action: 'read',
        description: 'View asset information',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'assets',
        action: 'update',
        description: 'Update asset details',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'assets',
        action: 'delete',
        description: 'Remove assets',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'assets',
        action: 'list',
        description: 'List all assets',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // REPORT PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'reports',
        action: 'create',
        description: 'Generate new reports',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'reports',
        action: 'read',
        description: 'View and download reports',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'reports',
        action: 'list',
        description: 'List all reports',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'reports',
        action: 'export',
        description: 'Export reports in various formats',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'reports',
        action: 'schedule',
        description: 'Schedule automated report generation',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // ROLE PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'roles',
        action: 'create',
        description: 'Create new roles',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'roles',
        action: 'read',
        description: 'View role configurations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'roles',
        action: 'update',
        description: 'Update role permissions',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'roles',
        action: 'delete',
        description: 'Remove roles',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'roles',
        action: 'list',
        description: 'List all roles',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'roles',
        action: 'assign',
        description: 'Assign roles to users',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // PERMISSION PERMISSIONS (META)
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'permissions',
        action: 'create',
        description: 'Create new permissions',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'permissions',
        action: 'read',
        description: 'View permission definitions',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'permissions',
        action: 'update',
        description: 'Update permission settings',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'permissions',
        action: 'delete',
        description: 'Remove permissions',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'permissions',
        action: 'list',
        description: 'List all permissions',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // ALERT/ALARM PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'alerts',
        action: 'create',
        description: 'Create alert rules and notifications',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'alerts',
        action: 'read',
        description: 'View alerts and notifications',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'alerts',
        action: 'update',
        description: 'Modify alert configurations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'alerts',
        action: 'delete',
        description: 'Remove alert rules',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'alerts',
        action: 'list',
        description: 'List all alerts',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'alerts',
        action: 'read',
        description: 'Read and manage alerts',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // ANALYTICS PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'analytics',
        action: 'read',
        description: 'View analytics and insights',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'analytics',
        action: 'export',
        description: 'Export analytics data',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'analytics',
        action: 'configure',
        description: 'Configure analytics settings',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // FLOOR PLAN PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'floor_plans',
        action: 'create',
        description: 'Create floor plans',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'floor_plans',
        action: 'read',
        description: 'View floor plans',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'floor_plans',
        action: 'update',
        description: 'Update floor plans',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'floor_plans',
        action: 'delete',
        description: 'Delete floor plans',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'floor_plans',
        action: 'list',
        description: 'List all floor plans',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // AUTOMATION PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'automations',
        action: 'create',
        description: 'Create automations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'automations',
        action: 'read',
        description: 'View automations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'automations',
        action: 'update',
        description: 'Update automations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'automations',
        action: 'delete',
        description: 'Delete automations',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'automations',
        action: 'list',
        description: 'List all automations',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // SETTINGS PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'settings',
        action: 'read',
        description: 'View system settings',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'settings',
        action: 'update',
        description: 'Modify system configuration',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // AUDIT LOG PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'audit-logs',
        action: 'read',
        description: 'View audit logs and system activity',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'audit-logs',
        action: 'list',
        description: 'List all audit logs',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'audit-logs',
        action: 'export',
        description: 'Export audit logs',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // BILLING PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'billing',
        action: 'read',
        description: 'View billing information',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'billing',
        action: 'manage',
        description: 'Manage billing and subscriptions',
        isSystem: true,
        tenantId: null,
      },

      // ════════════════════════════════════════════════════════════════
      // API KEY PERMISSIONS
      // ════════════════════════════════════════════════════════════════
      {
        resource: 'api-keys',
        action: 'create',
        description: 'Generate API keys',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'api-keys',
        action: 'read',
        description: 'View API keys',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'api-keys',
        action: 'list',
        description: 'List all API keys',
        isSystem: true,
        tenantId: null,
      },
      {
        resource: 'api-keys',
        action: 'delete',
        description: 'Revoke API keys',
        isSystem: true,
        tenantId: null,
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SEED SYSTEM PERMISSIONS
    // ════════════════════════════════════════════════════════════════
    let createdCount = 0;
    let errorCount = 0;

    for (const permissionData of systemPermissions) {
      try {
        const permission = this.permissionRepository.create(permissionData);
        await this.permissionRepository.save(permission);

        const permString = `${permissionData.resource}:${permissionData.action}`;
        this.logger.log(
          `✅ Created: ${permString.padEnd(35)} | 🔧 System | ${permissionData.description}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed ${permissionData.resource}:${permissionData.action}: ${error.message}`,
        );
        errorCount++;
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════════
    this.logger.log('');
    this.logger.log('🎉 Permission seeding completed!');
    this.logger.log(`   ✅ Permissions created: ${createdCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
    this.logger.log('');
    this.logger.log('📋 Permission Resource Distribution:');

    // Count unique resources
    const resourceGroups = systemPermissions.reduce((acc, perm) => {
      acc[perm.resource] = (acc[perm.resource] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(resourceGroups)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([resource, count]) => {
        this.logger.log(`   - ${resource.padEnd(20)}: ${count} permissions`);
      });

    this.logger.log('');
    this.logger.log(
      `📦 Total: ${systemPermissions.length} permissions across ${Object.keys(resourceGroups).length} resources`,
    );
    this.logger.log('');
    this.logger.log('💡 All permissions are system-wide (tenantId = null)');
    this.logger.log('💡 Tenants can create custom permissions via the API');
  }
}