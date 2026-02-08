import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission } from '@modules/permissions/entities/permissions.entity';
import { Role } from '@modules/roles/entities/roles.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class PermissionSeeder implements ISeeder {
  private readonly logger = new Logger(PermissionSeeder.name);

  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting permission seeding...');

    // ========================================
    // PERMISSION DATA
    // ========================================
    const permissions = [
      // ========================================
      // DEVICE PERMISSIONS
      // ========================================
      {
        resource: 'devices',
        action: 'create',
        description: 'Create new devices in the system',
        isSystem: true,
      },
      {
        resource: 'devices',
        action: 'read',
        description: 'View device information and details',
        isSystem: true,
      },
      {
        resource: 'devices',
        action: 'update',
        description: 'Update device configuration and settings',
        isSystem: true,
      },
      {
        resource: 'devices',
        action: 'delete',
        description: 'Remove devices from the system',
        isSystem: true,
      },
      {
        resource: 'devices',
        action: 'list',
        description: 'List all devices with filtering and pagination',
        isSystem: true,
      },
      {
        resource: 'devices',
        action: 'control',
        description: 'Send commands and control device operations',
        isSystem: true,
      },

      // ========================================
      // CUSTOMER PERMISSIONS
      // ========================================
      {
        resource: 'customers',
        action: 'create',
        description: 'Create new customer accounts',
        isSystem: true,
      },
      {
        resource: 'customers',
        action: 'read',
        description: 'View customer information',
        isSystem: true,
      },
      {
        resource: 'customers',
        action: 'update',
        description: 'Update customer details and settings',
        isSystem: true,
      },
      {
        resource: 'customers',
        action: 'delete',
        description: 'Remove customer accounts',
        isSystem: true,
      },
      {
        resource: 'customers',
        action: 'list',
        description: 'List all customers',
        isSystem: true,
      },

      // ========================================
      // TENANT PERMISSIONS
      // ========================================
      {
        resource: 'tenants',
        action: 'create',
        description: 'Create new tenant organizations',
        isSystem: true,
      },
      {
        resource: 'tenants',
        action: 'read',
        description: 'View tenant information',
        isSystem: true,
      },
      {
        resource: 'tenants',
        action: 'update',
        description: 'Update tenant configuration',
        isSystem: true,
      },
      {
        resource: 'tenants',
        action: 'delete',
        description: 'Remove tenant organizations',
        isSystem: true,
      },
      {
        resource: 'tenants',
        action: 'list',
        description: 'List all tenants',
        isSystem: true,
      },

      // ========================================
      // USER PERMISSIONS
      // ========================================
      {
        resource: 'users',
        action: 'create',
        description: 'Create new user accounts',
        isSystem: true,
      },
      {
        resource: 'users',
        action: 'read',
        description: 'View user profiles and information',
        isSystem: true,
      },
      {
        resource: 'users',
        action: 'update',
        description: 'Update user details and settings',
        isSystem: true,
      },
      {
        resource: 'users',
        action: 'delete',
        description: 'Remove user accounts',
        isSystem: true,
      },
      {
        resource: 'users',
        action: 'list',
        description: 'List all users',
        isSystem: true,
      },
      {
        resource: 'users',
        action: 'manage-roles',
        description: 'Assign and manage user roles',
        isSystem: true,
      },

      // ========================================
      // DASHBOARD PERMISSIONS
      // ========================================
      {
        resource: 'dashboards',
        action: 'create',
        description: 'Create custom dashboards',
        isSystem: true,
      },
      {
        resource: 'dashboards',
        action: 'read',
        description: 'View dashboards and analytics',
        isSystem: true,
      },
      {
        resource: 'dashboards',
        action: 'update',
        description: 'Modify dashboard configuration',
        isSystem: true,
      },
      {
        resource: 'dashboards',
        action: 'delete',
        description: 'Remove dashboards',
        isSystem: true,
      },
      {
        resource: 'dashboards',
        action: 'share',
        description: 'Share dashboards with other users',
        isSystem: true,
      },

      // ========================================
      // REPORT PERMISSIONS
      // ========================================
      {
        resource: 'reports',
        action: 'create',
        description: 'Generate new reports',
        isSystem: true,
      },
      {
        resource: 'reports',
        action: 'read',
        description: 'View and download reports',
        isSystem: true,
      },
      {
        resource: 'reports',
        action: 'export',
        description: 'Export reports in various formats',
        isSystem: true,
      },
      {
        resource: 'reports',
        action: 'schedule',
        description: 'Schedule automated report generation',
        isSystem: true,
      },

      // ========================================
      // ROLE PERMISSIONS
      // ========================================
      {
        resource: 'roles',
        action: 'create',
        description: 'Create new roles',
        isSystem: true,
      },
      {
        resource: 'roles',
        action: 'read',
        description: 'View role configurations',
        isSystem: true,
      },
      {
        resource: 'roles',
        action: 'update',
        description: 'Update role permissions',
        isSystem: true,
      },
      {
        resource: 'roles',
        action: 'delete',
        description: 'Remove roles',
        isSystem: true,
      },
      {
        resource: 'roles',
        action: 'assign',
        description: 'Assign roles to users',
        isSystem: true,
      },

      // ========================================
      // PERMISSION PERMISSIONS (META)
      // ========================================
      {
        resource: 'permissions',
        action: 'create',
        description: 'Create new permissions',
        isSystem: true,
      },
      {
        resource: 'permissions',
        action: 'read',
        description: 'View permission definitions',
        isSystem: true,
      },
      {
        resource: 'permissions',
        action: 'update',
        description: 'Update permission settings',
        isSystem: true,
      },
      {
        resource: 'permissions',
        action: 'delete',
        description: 'Remove permissions',
        isSystem: true,
      },

      // ========================================
      // ALERT PERMISSIONS
      // ========================================
      {
        resource: 'alerts',
        action: 'create',
        description: 'Create alert rules and notifications',
        isSystem: true,
      },
      {
        resource: 'alerts',
        action: 'read',
        description: 'View alerts and notifications',
        isSystem: true,
      },
      {
        resource: 'alerts',
        action: 'update',
        description: 'Modify alert configurations',
        isSystem: true,
      },
      {
        resource: 'alerts',
        action: 'delete',
        description: 'Remove alert rules',
        isSystem: true,
      },
      {
        resource: 'alerts',
        action: 'acknowledge',
        description: 'Acknowledge and manage alerts',
        isSystem: true,
      },

      // ========================================
      // ANALYTICS PERMISSIONS
      // ========================================
      {
        resource: 'analytics',
        action: 'read',
        description: 'View analytics and insights',
        isSystem: true,
      },
      {
        resource: 'analytics',
        action: 'export',
        description: 'Export analytics data',
        isSystem: true,
      },
      {
        resource: 'analytics',
        action: 'configure',
        description: 'Configure analytics settings',
        isSystem: true,
      },

      // ========================================
      // SETTINGS PERMISSIONS
      // ========================================
      {
        resource: 'settings',
        action: 'read',
        description: 'View system settings',
        isSystem: true,
      },
      {
        resource: 'settings',
        action: 'update',
        description: 'Modify system configuration',
        isSystem: true,
      },

      // ========================================
      // AUDIT LOG PERMISSIONS
      // ========================================
      {
        resource: 'audit-logs',
        action: 'read',
        description: 'View audit logs and system activity',
        isSystem: true,
      },
      {
        resource: 'audit-logs',
        action: 'export',
        description: 'Export audit logs',
        isSystem: true,
      },

      // ========================================
      // BILLING PERMISSIONS
      // ========================================
      {
        resource: 'billing',
        action: 'read',
        description: 'View billing information',
        isSystem: true,
      },
      {
        resource: 'billing',
        action: 'manage',
        description: 'Manage billing and subscriptions',
        isSystem: true,
      },

      // ========================================
      // API KEY PERMISSIONS
      // ========================================
      {
        resource: 'api-keys',
        action: 'create',
        description: 'Generate API keys',
        isSystem: true,
      },
      {
        resource: 'api-keys',
        action: 'read',
        description: 'View API keys',
        isSystem: true,
      },
      {
        resource: 'api-keys',
        action: 'revoke',
        description: 'Revoke API keys',
        isSystem: true,
      },
    ];

    // ========================================
    // SEED PERMISSIONS
    // ========================================
    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const permissionData of permissions) {
      try {
        const existing = await this.permissionRepository.findOne({
          where: {
            resource: permissionData.resource,
            action: permissionData.action,
          },
        });

        if (!existing) {
          const permission = this.permissionRepository.create(permissionData);
          await this.permissionRepository.save(permission);

          const permString = `${permissionData.resource}:${permissionData.action}`;
          this.logger.log(
            `✅ Created permission: ${permString.padEnd(35)} | ${permissionData.description}`,
          );
          createdCount++;
        } else {
          const permString = `${permissionData.resource}:${permissionData.action}`;
          this.logger.log(`⏭️  Permission already exists: ${permString}`);
          existingCount++;
        }
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed permission ${permissionData.resource}:${permissionData.action}: ${error.message}`,
        );
        errorCount++;
      }
    }

    // ========================================
    // SUMMARY
    // ========================================
    this.logger.log('🎉 Permission seeding completed!');
    this.logger.log(`   ✅ Permissions created: ${createdCount}`);
    this.logger.log(`   ⏭️  Permissions already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
    this.logger.log('');
    this.logger.log('📋 Permission Resource Distribution:');

    // Count unique resources
    const resourceGroups = permissions.reduce((acc, perm) => {
      acc[perm.resource] = (acc[perm.resource] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(resourceGroups)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([resource, count]) => {
        this.logger.log(`   - ${resource}: ${count} permissions`);
      });

    this.logger.log('');
    this.logger.log('💡 Tip: Use these permissions when creating roles');
  }
}