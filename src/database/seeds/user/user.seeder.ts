import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  User,
  UserRole,
  UserStatus,
} from '@modules/users/entities/user.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class UserSeeder implements ISeeder {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    // Fetch existing tenants
    const tenants = await this.tenantRepository.find({ take: 10 });

    if (tenants.length === 0) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Helper to get tenant by index (with fallback)
    const getTenantId = (index: number): string => {
      return tenants[index % tenants.length]?.id || tenants[0].id;
    };

    const users = [
      {
        name: 'Admin User',
        email: 'admin@iotplatform.com',
        password: 'Admin@123',
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234567',
        // Super admin has no tenantId
      },
      {
        name: 'Tenant Admin - Acme Corp',
        email: 'admin@acmecorp.com',
        password: 'TenantAdmin@123',
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234568',
        tenantId: getTenantId(0), // First tenant
      },
      {
        name: 'Tenant Admin - TechCo',
        email: 'admin@techco.com',
        password: 'TenantAdmin@123',
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234569',
        tenantId: getTenantId(1), // Second tenant
      },
      {
        name: 'John Doe',
        email: 'john.doe@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234570',
        tenantId: getTenantId(0),
      },
      {
        name: 'Jane Smith',
        email: 'jane.smith@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234571',
        tenantId: getTenantId(0),
      },
      {
        name: 'Michael Johnson',
        email: 'michael.johnson@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234572',
        tenantId: getTenantId(1),
      },
      {
        name: 'Sarah Williams',
        email: 'sarah.williams@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234573',
        tenantId: getTenantId(1),
      },
      {
        name: 'David Brown',
        email: 'david.brown@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: false,
        phone: '+966501234574',
        tenantId: getTenantId(0),
      },
      {
        name: 'Emily Davis',
        email: 'emily.davis@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.INACTIVE,
        emailVerified: true,
        phone: '+966501234575',
        tenantId: getTenantId(1),
      },
      {
        name: 'Robert Miller',
        email: 'robert.miller@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.SUSPENDED,
        emailVerified: true,
        phone: '+966501234576',
        tenantId: getTenantId(0),
      },
      {
        name: 'Lisa Anderson',
        email: 'lisa.anderson@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234577',
        tenantId: getTenantId(1),
      },
      {
        name: 'James Wilson',
        email: 'james.wilson@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        phone: '+966501234578',
        tenantId: getTenantId(0),
      },
      {
        name: 'Jennifer Martinez',
        email: 'jennifer.martinez@example.com',
        password: 'User@123',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        emailVerified: false,
        phone: '+966501234579',
        tenantId: getTenantId(1),
      },
    ];

    // If more than 2 tenants exist, distribute remaining users across other tenants
    if (tenants.length > 2) {
      const additionalUsers = [
        {
          name: 'Carlos Rodriguez',
          email: 'carlos.rodriguez@example.com',
          password: 'User@123',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          emailVerified: true,
          phone: '+966501234580',
          tenantId: getTenantId(2),
        },
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
      users.push(...additionalUsers);
    }

    for (const userData of users) {
      const existing = await this.userRepository.findOne({
        where: { email: userData.email },
      });

      if (!existing) {
        const user = this.userRepository.create(userData);
        await this.userRepository.save(user);
        console.log(
          `✅ Created user: ${userData.email} (${userData.role})${userData.tenantId ? ` - Tenant: ${userData.tenantId}` : ''}`,
        );
      } else {
        console.log(`⏭️  User already exists: ${userData.email}`);
      }
    }

    console.log('🎉 User seeding completed!');
    console.log(`   - Total tenants found: ${tenants.length}`);
    console.log(`   - Users created/checked: ${users.length}`);
  }
}
