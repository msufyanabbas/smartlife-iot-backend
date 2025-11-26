import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, TenantStatus } from '@modules/tenants/entities/tenant.entity';
import { User, UserRole } from '@modules/users/entities/user.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class TenantSeeder implements ISeeder {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch tenant admins for assignment
    const tenantAdmins = await this.userRepository.find({
      where: { role: UserRole.TENANT_ADMIN },
    });

    const tenants = [
      // System Default Tenant
      {
        name: 'default-tenant',
        title: 'Default System Tenant',
        description:
          'Default system tenant for platform administration and testing',
        email: 'admin@defaulttenant.com',
        phone: '+1-555-0100',
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
        address: '123 System Street',
        address2: 'Suite 100',
        zip: '94102',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/default-tenant.png',
          website: 'https://defaulttenant.com',
          industry: 'Technology',
          employeeCount: 1000,
        },
        configuration: {
          maxDevices: 10000,
          maxUsers: 1000,
          maxAssets: 5000,
          maxDashboards: 500,
          maxRuleChains: 100,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'customBranding',
            'apiAccess',
            'whiteLabeling',
            'multiTenancy',
            'mlPredictions',
            'customReports',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[0]?.id,
      },
      // Manufacturing Companies
      {
        name: 'acme-manufacturing',
        title: 'Acme Manufacturing Inc.',
        description:
          'Leading industrial manufacturing company specializing in automotive parts',
        email: 'admin@acmemanufacturing.com',
        phone: '+1-313-555-0101',
        country: 'United States',
        state: 'Michigan',
        city: 'Detroit',
        address: '456 Industrial Boulevard',
        address2: 'Building A',
        zip: '48201',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/acme-manufacturing.png',
          website: 'https://acmemanufacturing.com',
          industry: 'Manufacturing',
          employeeCount: 500,
        },
        configuration: {
          maxDevices: 500,
          maxUsers: 50,
          maxAssets: 250,
          maxDashboards: 25,
          maxRuleChains: 15,
          dataRetentionDays: 180,
          features: [
            'advancedAnalytics',
            'customBranding',
            'apiAccess',
            'customReports',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[1]?.id || tenantAdmins[0]?.id,
      },
      {
        name: 'techco-industries',
        title: 'TechCo Industries Ltd.',
        description: 'Electronics manufacturing and IoT device production',
        email: 'contact@techco-industries.com',
        phone: '+1-408-555-0102',
        country: 'United States',
        state: 'California',
        city: 'San Jose',
        address: '789 Tech Park Drive',
        zip: '95110',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/techco.png',
          website: 'https://techco-industries.com',
          industry: 'Electronics Manufacturing',
          employeeCount: 750,
        },
        configuration: {
          maxDevices: 800,
          maxUsers: 80,
          maxAssets: 400,
          maxDashboards: 40,
          maxRuleChains: 20,
          dataRetentionDays: 270,
          features: [
            'advancedAnalytics',
            'customBranding',
            'apiAccess',
            'mlPredictions',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },
      // Smart Building Companies
      {
        name: 'smart-buildings-corp',
        title: 'Smart Buildings Corporation',
        description:
          'Building automation and smart facility management solutions',
        email: 'info@smartbuildings.com',
        phone: '+1-212-555-0103',
        country: 'United States',
        state: 'New York',
        city: 'New York',
        address: '321 Smart Avenue',
        address2: 'Floor 15',
        zip: '10001',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/smart-buildings.png',
          website: 'https://smartbuildings.com',
          industry: 'Building Automation',
          employeeCount: 250,
        },
        configuration: {
          maxDevices: 1000,
          maxUsers: 100,
          maxAssets: 500,
          maxDashboards: 50,
          maxRuleChains: 30,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'customBranding',
            'apiAccess',
            'energyOptimization',
            'predictiveMaintenance',
          ],
        },
        isolationMode: 'full',
      },
      // Agriculture Tech
      {
        name: 'agritech-solutions',
        title: 'AgriTech Solutions',
        description: 'Precision agriculture and smart farming technology',
        email: 'contact@agritech-solutions.com',
        phone: '+1-515-555-0104',
        country: 'United States',
        state: 'Iowa',
        city: 'Des Moines',
        address: '654 Farm Road',
        zip: '50309',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/agritech.png',
          website: 'https://agritech-solutions.com',
          industry: 'Agriculture Technology',
          employeeCount: 150,
        },
        configuration: {
          maxDevices: 300,
          maxUsers: 30,
          maxAssets: 150,
          maxDashboards: 15,
          maxRuleChains: 10,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'weatherIntegration',
            'soilMonitoring',
            'cropPrediction',
          ],
        },
        isolationMode: 'full',
      },
      // Healthcare
      {
        name: 'healthtech-medical',
        title: 'HealthTech Medical Systems',
        description: 'Medical device monitoring and healthcare IoT solutions',
        email: 'admin@healthtech-medical.com',
        phone: '+1-617-555-0105',
        country: 'United States',
        state: 'Massachusetts',
        city: 'Boston',
        address: '147 Medical Center Drive',
        address2: 'Suite 300',
        zip: '02115',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/healthtech.png',
          website: 'https://healthtech-medical.com',
          industry: 'Healthcare',
          employeeCount: 400,
        },
        configuration: {
          maxDevices: 600,
          maxUsers: 60,
          maxAssets: 300,
          maxDashboards: 30,
          maxRuleChains: 20,
          dataRetentionDays: 730, // 2 years for medical compliance
          features: [
            'advancedAnalytics',
            'hipaaCompliance',
            'patientMonitoring',
            'alertManagement',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },
      // Logistics & Fleet
      {
        name: 'global-logistics',
        title: 'Global Logistics International',
        description: 'Fleet management and supply chain IoT solutions',
        email: 'operations@global-logistics.com',
        phone: '+1-404-555-0106',
        country: 'United States',
        state: 'Georgia',
        city: 'Atlanta',
        address: '852 Logistics Parkway',
        zip: '30303',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/global-logistics.png',
          website: 'https://global-logistics.com',
          industry: 'Logistics & Transportation',
          employeeCount: 2000,
        },
        configuration: {
          maxDevices: 2000,
          maxUsers: 200,
          maxAssets: 1000,
          maxDashboards: 100,
          maxRuleChains: 50,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'gpsTracking',
            'routeOptimization',
            'fleetManagement',
            'geofencing',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },
      // Energy & Utilities
      {
        name: 'green-energy-systems',
        title: 'Green Energy Systems',
        description: 'Renewable energy monitoring and smart grid solutions',
        email: 'info@green-energy.com',
        phone: '+1-512-555-0107',
        country: 'United States',
        state: 'Texas',
        city: 'Austin',
        address: '963 Solar Boulevard',
        zip: '78701',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/green-energy.png',
          website: 'https://green-energy.com',
          industry: 'Energy & Utilities',
          employeeCount: 300,
        },
        configuration: {
          maxDevices: 1500,
          maxUsers: 150,
          maxAssets: 750,
          maxDashboards: 75,
          maxRuleChains: 40,
          dataRetentionDays: 1825, // 5 years
          features: [
            'advancedAnalytics',
            'energyForecasting',
            'gridOptimization',
            'carbonTracking',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },
      // Retail
      {
        name: 'retail-smart-stores',
        title: 'Smart Stores Retail Network',
        description: 'Smart retail and store automation solutions',
        email: 'tech@smartstores.com',
        phone: '+1-206-555-0108',
        country: 'United States',
        state: 'Washington',
        city: 'Seattle',
        address: '741 Retail Plaza',
        address2: 'Building 2',
        zip: '98101',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/smart-stores.png',
          website: 'https://smartstores.com',
          industry: 'Retail',
          employeeCount: 5000,
        },
        configuration: {
          maxDevices: 3000,
          maxUsers: 300,
          maxAssets: 1500,
          maxDashboards: 150,
          maxRuleChains: 75,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'customerTracking',
            'inventoryManagement',
            'energyMonitoring',
            'securityIntegration',
          ],
        },
        isolationMode: 'shared',
      },
      // Demo/Testing Tenants
      {
        name: 'demo-corporation',
        title: 'Demo Corporation',
        description: 'Demo tenant for testing and proof of concept',
        email: 'demo@democorp.com',
        phone: '+1-555-0109',
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
        address: '999 Demo Street',
        zip: '94105',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.example.com/logos/demo.png',
          website: 'https://democorp.com',
          industry: 'Technology',
          employeeCount: 10,
        },
        configuration: {
          maxDevices: 100,
          maxUsers: 10,
          maxAssets: 50,
          maxDashboards: 10,
          maxRuleChains: 5,
          dataRetentionDays: 90,
          features: ['advancedAnalytics', 'apiAccess'],
        },
        isolationMode: 'shared',
      },
      // Inactive/Suspended Tenants
      {
        name: 'legacy-systems-inc',
        title: 'Legacy Systems Inc.',
        description: 'Former client - account suspended for non-payment',
        email: 'admin@legacy-systems.com',
        phone: '+1-555-0110',
        country: 'United States',
        state: 'New Jersey',
        city: 'Newark',
        address: '123 Old Tech Road',
        zip: '07102',
        status: TenantStatus.SUSPENDED,
        additionalInfo: {
          website: 'https://legacy-systems.com',
          industry: 'Technology',
          employeeCount: 50,
        },
        configuration: {
          maxDevices: 200,
          maxUsers: 20,
          maxAssets: 100,
          maxDashboards: 10,
          maxRuleChains: 5,
          dataRetentionDays: 30,
          features: [],
        },
        isolationMode: 'full',
      },
      {
        name: 'test-tenant-inactive',
        title: 'Test Tenant - Inactive',
        description: 'Inactive test tenant for development purposes',
        email: 'test@inactive.com',
        phone: '+1-555-0111',
        country: 'United States',
        state: 'California',
        city: 'Los Angeles',
        address: '456 Test Avenue',
        zip: '90001',
        status: TenantStatus.INACTIVE,
        additionalInfo: {
          industry: 'Testing',
          employeeCount: 0,
        },
        configuration: {
          maxDevices: 50,
          maxUsers: 5,
          maxAssets: 25,
          maxDashboards: 5,
          maxRuleChains: 3,
          dataRetentionDays: 30,
          features: [],
        },
        isolationMode: 'shared',
      },
    ];

    for (const tenantData of tenants) {
      const existing = await this.tenantRepository.findOne({
        where: { name: tenantData.name },
      });

      if (!existing) {
        const tenant = this.tenantRepository.create(tenantData as any);
        await this.tenantRepository.save(tenant);
        console.log(
          `✅ Created tenant: ${tenantData.name} (${tenantData.status})`,
        );
      } else {
        console.log(`⏭️  Tenant already exists: ${tenantData.name}`);
      }
    }

    console.log('🎉 Tenant seeding completed!');
  }
}
