import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  User,
  UserRole,
  UserStatus,
} from '@modules/users/entities/user.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { Customer } from '@modules/customers/entities/customers.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class UserSeeder implements ISeeder {
  private readonly logger = new Logger(UserSeeder.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting user seeding...');

    // ========================================
    // FETCH EXISTING TENANTS AND CUSTOMERS
    // ========================================
    const tenants = await this.tenantRepository.find({ take: 10 });
    const customers = await this.customerRepository.find({ take: 20 });

    if (tenants.length === 0) {
      this.logger.warn(
        '⚠️  No tenants found. Please seed tenants first. Skipping user seeding.',
      );
      return;
    }

    this.logger.log(`📊 Found ${tenants.length} tenant(s)`);
    this.logger.log(`📊 Found ${customers.length} customer(s)`);

    // ========================================
    // HELPER FUNCTIONS
    // ========================================
    const getTenantId = (index: number): string => {
      return tenants[index % tenants.length]?.id || tenants[0].id;
    };

    const getCustomerId = (index: number): string | undefined => {
      if (customers.length === 0) return undefined;
      return customers[index % customers.length]?.id;
    };

    // ========================================
    // USER DATA
    // ========================================
    const users = [
      // ========================================
      // SUPER ADMIN (Platform Admin)
      // ========================================
      {
        name: 'Admin User',
        email: 'admin@iotplatform.com',
        password: 'Admin@123',
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234567',
        // Super admin has no tenantId or customerId
      },

      // ========================================
      // TENANT ADMINS (Organization Admins)
      // ========================================
      {
        name: 'Tenant Admin - Acme Corp',
        email: 'admin@acmecorp.com',
        password: 'TenantAdmin@123',
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234568',
        tenantId: getTenantId(0),
      },
      {
        name: 'Tenant Admin - TechCo',
        email: 'admin@techco.com',
        password: 'TenantAdmin@123',
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234569',
        tenantId: getTenantId(1),
      },

      // ========================================
      // CUSTOMER ADMINS (End-Client Admins)
      // ========================================
      {
        name: 'John Doe',
        email: 'john.doe@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234570',
        tenantId: getTenantId(0),
        customerId: getCustomerId(0),
      },
      {
        name: 'Jane Smith',
        email: 'jane.smith@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234571',
        tenantId: getTenantId(0),
        customerId: getCustomerId(1),
      },
      {
        name: 'Michael Johnson',
        email: 'michael.johnson@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234572',
        tenantId: getTenantId(1),
        customerId: getCustomerId(2),
      },
      {
        name: 'Sarah Williams',
        email: 'sarah.williams@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234573',
        tenantId: getTenantId(1),
        customerId: getCustomerId(3),
      },

      // ========================================
      // CUSTOMER USERS (End Users)
      // ========================================
      {
        name: 'David Brown',
        email: 'david.brown@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.ACTIVE,
        emailVerified: false,
        phone: '+966501234574',
        tenantId: getTenantId(0),
        customerId: getCustomerId(0),
      },
      {
        name: 'Emily Davis',
        email: 'emily.davis@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.INACTIVE,
        emailVerified: true,
        phone: '+966501234575',
        tenantId: getTenantId(1),
        customerId: getCustomerId(1),
      },
      {
        name: 'Robert Miller',
        email: 'robert.miller@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.SUSPENDED,
        emailVerified: true,
        phone: '+966501234576',
        tenantId: getTenantId(0),
        customerId: getCustomerId(2),
      },
      {
        name: 'Lisa Anderson',
        email: 'lisa.anderson@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234577',
        tenantId: getTenantId(1),
        customerId: getCustomerId(3),
      },
      {
        name: 'James Wilson',
        email: 'james.wilson@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234578',
        tenantId: getTenantId(0),
        customerId: getCustomerId(4),
      },
      {
        name: 'Jennifer Martinez',
        email: 'jennifer.martinez@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.ACTIVE,
        emailVerified: false,
        phone: '+966501234579',
        tenantId: getTenantId(1),
        customerId: getCustomerId(5),
      },
      {
        name: 'Carlos Rodriguez',
        email: 'carlos.rodriguez@example.com',
        password: 'User@123',
        role: UserRole.CUSTOMER_USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234580',
        tenantId: getTenantId(2),
        customerId: getCustomerId(6),
      },

      // ========================================
      // REGULAR USERS (Deprecated/Legacy Role)
      // Note: In IoT platforms, this role is typically not used
      // Users should be either TENANT_ADMIN, CUSTOMER_ADMIN, or CUSTOMER_USER
      // ========================================
      {
        name: 'Patricia Garcia',
        email: 'patricia.garcia@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234581',
        tenantId: getTenantId(2),
      },
    ];

    // ========================================
    // ADD MORE USERS IF MORE TENANTS/CUSTOMERS EXIST
    // ========================================
    if (tenants.length > 3) {
      const additionalTenantAdmins = [
        {
          name: 'Tenant Admin - Additional 1',
          email: 'admin@tenant4.com',
          password: 'TenantAdmin@123',
          role: UserRole.TENANT_ADMIN,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234582',
          tenantId: getTenantId(3),
        },
        {
          name: 'Tenant Admin - Additional 2',
          email: 'admin@tenant5.com',
          password: 'TenantAdmin@123',
          role: UserRole.TENANT_ADMIN,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234583',
          tenantId: getTenantId(4),
        },
      ];
      users.push(...additionalTenantAdmins);
    }

    if (customers.length > 7) {
      const additionalCustomerUsers = [
        {
          name: 'Additional Customer Admin 1',
          email: 'admin@customer8.com',
          password: 'User@123',
          role: UserRole.CUSTOMER_ADMIN,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234584',
          tenantId: getTenantId(2),
          customerId: getCustomerId(7),
        },
        {
          name: 'Additional Customer User 1',
          email: 'user1@customer8.com',
          password: 'User@123',
          role: UserRole.CUSTOMER_USER,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234585',
          tenantId: getTenantId(2),
          customerId: getCustomerId(7),
        },
        {
          name: 'Additional Customer User 2',
          email: 'user2@customer9.com',
          password: 'User@123',
          role: UserRole.CUSTOMER_USER,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234586',
          tenantId: getTenantId(3),
          customerId: getCustomerId(8),
        },
        {
          name: 'Additional Customer User 3',
          email: 'user3@customer10.com',
          password: 'User@123',
          role: UserRole.CUSTOMER_USER,
          status: UserStatus.ACTIVE,
          emailVerified: false,
          phone: '+966501234587',
          tenantId: getTenantId(3),
          customerId: getCustomerId(9),
        },
      ];
      users.push(...additionalCustomerUsers);
    }

    // ========================================
    // SEED USERS
    // ========================================
    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const userData of users) {
      try {
        const existing = await this.userRepository.findOne({
          where: { email: userData.email },
        });

        if (!existing) {
          // Validate that tenantId and customerId exist if provided
          if (userData.tenantId) {
            const tenant = await this.tenantRepository.findOne({
              where: { id: userData.tenantId },
            });
            if (!tenant) {
              this.logger.warn(
                `⚠️  Tenant ${userData.tenantId} not found for user ${userData.email}. Skipping.`,
              );
              errorCount++;
              continue;
            }
          }

          if (userData.customerId) {
            const customer = await this.customerRepository.findOne({
              where: { id: userData.customerId },
            });
            if (!customer) {
              this.logger.warn(
                `⚠️  Customer ${userData.customerId} not found for user ${userData.email}. Setting customerId to null.`,
              );
              // Set customerId to undefined instead of skipping
              userData.customerId = undefined;
            }
          }

          const user = this.userRepository.create(userData);
          await this.userRepository.save(user);

          const roleDisplay = this.getRoleDisplay(userData.role);
          const statusDisplay = this.getStatusEmoji(userData.status);
          const verifiedDisplay = userData.emailVerified ? '✅' : '❌';

          this.logger.log(
            `✅ Created user: ${userData.email.padEnd(40)} | ${roleDisplay.padEnd(20)} | ${statusDisplay} | Email: ${verifiedDisplay}${userData.tenantId ? ` | Tenant: ${userData.tenantId.slice(0, 8)}...` : ''}${userData.customerId ? ` | Customer: ${userData.customerId.slice(0, 8)}...` : ''}`,
          );
          createdCount++;
        } else {
          this.logger.log(`⏭️  User already exists: ${userData.email}`);
          existingCount++;
        }
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed user ${userData.email}: ${error.message}`,
        );
        errorCount++;
      }
    }

    // ========================================
    // SUMMARY
    // ========================================
    this.logger.log('🎉 User seeding completed!');
    this.logger.log(`   ✅ Users created: ${createdCount}`);
    this.logger.log(`   ⏭️  Users already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
    this.logger.log(`   📊 Total tenants: ${tenants.length}`);
    this.logger.log(`   📊 Total customers: ${customers.length}`);
    this.logger.log('');
    this.logger.log('📋 User Role Distribution:');
    this.logger.log(
      `   - Super Admins: ${users.filter((u) => u.role === UserRole.SUPER_ADMIN).length}`,
    );
    this.logger.log(
      `   - Tenant Admins: ${users.filter((u) => u.role === UserRole.TENANT_ADMIN).length}`,
    );
    this.logger.log(
      `   - Customer Admins: ${users.filter((u) => u.role === UserRole.CUSTOMER_ADMIN).length}`,
    );
    this.logger.log(
      `   - Customer Users: ${users.filter((u) => u.role === UserRole.CUSTOMER_USER).length}`,
    );
    this.logger.log(
      `   - Legacy Users: ${users.filter((u) => u.role === UserRole.USER).length}`,
    );
    this.logger.log('');
    this.logger.log('🔑 Default Credentials:');
    this.logger.log('   - Super Admin: Admin@123');
    this.logger.log('   - Tenant Admin: TenantAdmin@123');
    this.logger.log('   - Customer Admin/User: User@123');
  }

  /**
   * Helper: Get display name for role
   */
  private getRoleDisplay(role: UserRole): string {
    const roleMap = {
      [UserRole.SUPER_ADMIN]: '👑 Super Admin',
      [UserRole.TENANT_ADMIN]: '🏢 Tenant Admin',
      [UserRole.CUSTOMER_ADMIN]: '👤 Customer Admin',
      [UserRole.CUSTOMER_USER]: '👥 Customer User',
      [UserRole.USER]: '📝 User (Legacy)',
    };
    return roleMap[role] || role;
  }

  /**
   * Helper: Get emoji for status
   */
  private getStatusEmoji(status: UserStatus): string {
    const statusMap = {
      [UserStatus.ACTIVE]: '🟢 Active',
      [UserStatus.INACTIVE]: '🟡 Inactive',
      [UserStatus.SUSPENDED]: '🔴 Suspended',
    };
    return statusMap[status] || status;
  }
}