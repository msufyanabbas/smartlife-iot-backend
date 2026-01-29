import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, TenantStatus } from '@modules/tenants/entities/tenant.entity';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class TenantSeeder implements ISeeder {
  private readonly logger = new Logger(TenantSeeder.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting tenant seeding...');

    // ========================================
    // FETCH TENANT ADMINS FOR ASSIGNMENT
    // ========================================
    const tenantAdmins = await this.userRepository.find({
      where: { role: UserRole.TENANT_ADMIN },
    });

    this.logger.log(`📊 Found ${tenantAdmins.length} tenant admin(s)`);

    if (tenantAdmins.length === 0) {
      this.logger.warn(
        '⚠️  No tenant admins found. Tenants will be created without admin assignments.',
      );
    }

    // ========================================
    // TENANT DATA
    // ========================================
    const tenants = [
      // ========================================
      // 1. SMART LIFE - SYSTEM DEFAULT TENANT
      // ========================================
      {
        name: 'smart-life-platform',
        title: 'Smart Life IoT Platform',
        description:
          'Default system tenant for Smart Life IoT platform administration, testing, and internal operations',
        email: 'admin@smartlife.sa',
        phone: '+966112345678',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'King Fahd Road, Al Olaya District',
        address2: 'Building 5, Floor 10',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/smart-life-platform.png',
          website: 'https://smartlife.sa',
          industry: 'IoT Platform Provider',
          employeeCount: 150,
        },
        configuration: {
          maxDevices: 50000,
          maxUsers: 5000,
          maxCustomers: 1000,
          maxAssets: 25000,
          maxDashboards: 2500,
          maxRuleChains: 500,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'customBranding',
            'apiAccess',
            'whiteLabeling',
            'multiTenancy',
            'mlPredictions',
            'customReports',
            'unlimitedAccess',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[0]?.id,
      },

      // ========================================
      // 2. SMART CITY & INFRASTRUCTURE
      // ========================================
      {
        name: 'riyadh-smart-city',
        title: 'Riyadh Smart City Initiative',
        description:
          'Smart city infrastructure management for Riyadh municipality - traffic, lighting, environmental monitoring',
        email: 'iot@riyadhcity.gov.sa',
        phone: '+966114567890',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Imam Abdullah bin Saud Road',
        address2: 'Municipal Center',
        zip: '11461',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/riyadh-smart-city.png',
          website: 'https://riyadhcity.gov.sa',
          industry: 'Smart City & Government',
          employeeCount: 500,
        },
        configuration: {
          maxDevices: 10000,
          maxUsers: 200,
          maxCustomers: 50,
          maxAssets: 5000,
          maxDashboards: 150,
          maxRuleChains: 100,
          dataRetentionDays: 730, // 2 years for government compliance
          features: [
            'advancedAnalytics',
            'gisIntegration',
            'trafficManagement',
            'environmentalMonitoring',
            'publicSafety',
            'customReports',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[1]?.id || tenantAdmins[0]?.id,
      },

      {
        name: 'neom-smart-infrastructure',
        title: 'NEOM Smart Infrastructure',
        description:
          'Next-generation smart city infrastructure for NEOM mega-project',
        email: 'iot@neom.sa',
        phone: '+966114567891',
        country: 'Saudi Arabia',
        state: 'Tabuk Region',
        city: 'NEOM',
        address: 'NEOM Bay',
        zip: '49643',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/neom.png',
          website: 'https://neom.sa',
          industry: 'Smart City & Mega Projects',
          employeeCount: 1000,
        },
        configuration: {
          maxDevices: 20000,
          maxUsers: 500,
          maxCustomers: 100,
          maxAssets: 10000,
          maxDashboards: 300,
          maxRuleChains: 200,
          dataRetentionDays: 1825, // 5 years
          features: [
            'advancedAnalytics',
            'mlPredictions',
            'smartGrid',
            'sustainabilityTracking',
            'innovationLab',
            'customReports',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[2]?.id || tenantAdmins[0]?.id,
      },

      // ========================================
      // 3. REAL ESTATE & BUILDING MANAGEMENT
      // ========================================
      {
        name: 'al-hokair-properties',
        title: 'Al Hokair Real Estate & Development',
        description:
          'Smart building automation for commercial and residential properties across Saudi Arabia',
        email: 'iot@alhokair.com.sa',
        phone: '+966112345679',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Olaya Street',
        address2: 'Al Hokair Tower',
        zip: '11543',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/al-hokair.png',
          website: 'https://alhokair.com.sa',
          industry: 'Real Estate & Property Management',
          employeeCount: 300,
        },
        configuration: {
          maxDevices: 5000,
          maxUsers: 150,
          maxCustomers: 100,
          maxAssets: 2500,
          maxDashboards: 80,
          maxRuleChains: 50,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'buildingAutomation',
            'energyOptimization',
            'accessControl',
            'predictiveMaintenance',
            'customReports',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[3]?.id || tenantAdmins[0]?.id,
      },

      {
        name: 'dar-al-arkan-smart-homes',
        title: 'Dar Al Arkan Smart Homes',
        description:
          'Luxury smart home automation for premium residential developments',
        email: 'smarthomes@daralarkan.com',
        phone: '+966112345680',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'King Abdullah Financial District',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/dar-al-arkan.png',
          website: 'https://daralarkan.com',
          industry: 'Luxury Real Estate',
          employeeCount: 200,
        },
        configuration: {
          maxDevices: 3000,
          maxUsers: 100,
          maxCustomers: 150,
          maxAssets: 1500,
          maxDashboards: 60,
          maxRuleChains: 40,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'homeAutomation',
            'securityIntegration',
            'energyMonitoring',
            'luxuryFeatures',
          ],
        },
        isolationMode: 'full',
        tenantAdminId: tenantAdmins[4]?.id || tenantAdmins[0]?.id,
      },

      // ========================================
      // 4. HOSPITALITY & TOURISM
      // ========================================
      {
        name: 'rotana-smart-hotels',
        title: 'Rotana Hotels Smart Management',
        description:
          'Smart hotel room automation and facility management across Rotana properties',
        email: 'iot@rotana.com',
        phone: '+966112345681',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Murooj District',
        zip: '11461',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/rotana.png',
          website: 'https://rotana.com',
          industry: 'Hospitality',
          employeeCount: 500,
        },
        configuration: {
          maxDevices: 4000,
          maxUsers: 120,
          maxCustomers: 80,
          maxAssets: 2000,
          maxDashboards: 50,
          maxRuleChains: 35,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'roomAutomation',
            'guestExperience',
            'energyOptimization',
            'predictiveMaintenance',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 5. HEALTHCARE
      // ========================================
      {
        name: 'king-faisal-specialist-hospital',
        title: 'King Faisal Specialist Hospital & Research Centre',
        description:
          'Medical device monitoring and healthcare IoT solutions for KFSHRC facilities',
        email: 'iot@kfshrc.edu.sa',
        phone: '+966114647272',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Maather Street',
        address2: 'Medical Complex',
        zip: '11211',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/kfshrc.png',
          website: 'https://kfshrc.edu.sa',
          industry: 'Healthcare',
          employeeCount: 1000,
        },
        configuration: {
          maxDevices: 3000,
          maxUsers: 200,
          maxCustomers: 30,
          maxAssets: 1500,
          maxDashboards: 80,
          maxRuleChains: 60,
          dataRetentionDays: 2555, // 7 years for medical compliance
          features: [
            'advancedAnalytics',
            'medicalCompliance',
            'patientMonitoring',
            'assetTracking',
            'alertManagement',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      {
        name: 'saudi-german-hospital',
        title: 'Saudi German Hospital Network',
        description:
          'Healthcare IoT platform for Saudi German Hospital facilities',
        email: 'it@sghgroup.com.sa',
        phone: '+966114308000',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Hamra District',
        zip: '11543',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/saudi-german.png',
          website: 'https://sghgroup.com.sa',
          industry: 'Healthcare',
          employeeCount: 800,
        },
        configuration: {
          maxDevices: 2500,
          maxUsers: 150,
          maxCustomers: 25,
          maxAssets: 1200,
          maxDashboards: 60,
          maxRuleChains: 45,
          dataRetentionDays: 2555, // 7 years
          features: [
            'advancedAnalytics',
            'medicalCompliance',
            'equipmentMonitoring',
            'environmentalControl',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 6. INDUSTRIAL & MANUFACTURING
      // ========================================
      {
        name: 'sabic-industrial-iot',
        title: 'SABIC Industrial IoT Solutions',
        description:
          'Industrial automation and process monitoring for SABIC manufacturing facilities',
        email: 'iot@sabic.com',
        phone: '+966133581000',
        country: 'Saudi Arabia',
        state: 'Eastern Region',
        city: 'Jubail',
        address: 'Jubail Industrial City',
        zip: '31961',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/sabic.png',
          website: 'https://sabic.com',
          industry: 'Petrochemicals & Manufacturing',
          employeeCount: 5000,
        },
        configuration: {
          maxDevices: 15000,
          maxUsers: 500,
          maxCustomers: 50,
          maxAssets: 7500,
          maxDashboards: 200,
          maxRuleChains: 150,
          dataRetentionDays: 1825, // 5 years
          features: [
            'advancedAnalytics',
            'industrialAutomation',
            'processMonitoring',
            'predictiveMaintenance',
            'safetyManagement',
            'mlPredictions',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      {
        name: 'maaden-mining-iot',
        title: 'Ma\'aden Mining Operations',
        description:
          'Smart mining operations and equipment monitoring for Ma\'aden facilities',
        email: 'iot@maaden.com.sa',
        phone: '+966114788888',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'King Abdullah Financial District',
        zip: '13519',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/maaden.png',
          website: 'https://maaden.com.sa',
          industry: 'Mining & Resources',
          employeeCount: 3000,
        },
        configuration: {
          maxDevices: 8000,
          maxUsers: 250,
          maxCustomers: 30,
          maxAssets: 4000,
          maxDashboards: 120,
          maxRuleChains: 80,
          dataRetentionDays: 1825, // 5 years
          features: [
            'advancedAnalytics',
            'equipmentMonitoring',
            'safetyTracking',
            'environmentalMonitoring',
            'predictiveMaintenance',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 7. RETAIL & SHOPPING MALLS
      // ========================================
      {
        name: 'arabian-centres-smart-malls',
        title: 'Arabian Centres Smart Mall Management',
        description:
          'Smart shopping mall operations and customer experience platforms',
        email: 'iot@arabiancentres.com',
        phone: '+966112183333',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'King Fahd Road',
        address2: 'Arabian Centres HQ',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/arabian-centres.png',
          website: 'https://arabiancentres.com',
          industry: 'Retail & Shopping Malls',
          employeeCount: 400,
        },
        configuration: {
          maxDevices: 6000,
          maxUsers: 180,
          maxCustomers: 120,
          maxAssets: 3000,
          maxDashboards: 90,
          maxRuleChains: 60,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'customerTracking',
            'energyMonitoring',
            'securityIntegration',
            'parkingManagement',
            'customReports',
          ],
        },
        isolationMode: 'shared',
      },

      // ========================================
      // 8. AGRICULTURE & FOOD SECURITY
      // ========================================
      {
        name: 'al-marai-smart-farming',
        title: 'Almarai Smart Agriculture',
        description:
          'Precision agriculture and smart farming for dairy and food production',
        email: 'iot@almarai.com',
        phone: '+966114710777',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Exit 7, North Ring Road',
        zip: '11491',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/almarai.png',
          website: 'https://almarai.com',
          industry: 'Agriculture & Food Production',
          employeeCount: 2000,
        },
        configuration: {
          maxDevices: 5000,
          maxUsers: 150,
          maxCustomers: 40,
          maxAssets: 2500,
          maxDashboards: 75,
          maxRuleChains: 50,
          dataRetentionDays: 730, // 2 years
          features: [
            'advancedAnalytics',
            'precisionAgriculture',
            'livestockMonitoring',
            'climateControl',
            'yieldPrediction',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 9. LOGISTICS & TRANSPORTATION
      // ========================================
      {
        name: 'saudi-post-smart-logistics',
        title: 'Saudi Post (SPL) Smart Logistics',
        description:
          'Fleet management and supply chain IoT for Saudi postal services',
        email: 'iot@sp.com.sa',
        phone: '+966114605555',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Wazarat District',
        zip: '11441',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/saudi-post.png',
          website: 'https://sp.com.sa',
          industry: 'Logistics & Postal Services',
          employeeCount: 1500,
        },
        configuration: {
          maxDevices: 10000,
          maxUsers: 300,
          maxCustomers: 100,
          maxAssets: 5000,
          maxDashboards: 150,
          maxRuleChains: 100,
          dataRetentionDays: 365,
          features: [
            'advancedAnalytics',
            'fleetManagement',
            'gpsTracking',
            'routeOptimization',
            'packageTracking',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 10. ENERGY & UTILITIES
      // ========================================
      {
        name: 'sec-smart-grid',
        title: 'Saudi Electricity Company Smart Grid',
        description:
          'Smart grid management and energy distribution monitoring',
        email: 'iot@se.com.sa',
        phone: '+966920000222',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Mursilat District',
        zip: '11551',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/sec.png',
          website: 'https://se.com.sa',
          industry: 'Energy & Utilities',
          employeeCount: 8000,
        },
        configuration: {
          maxDevices: 50000,
          maxUsers: 1000,
          maxCustomers: 500,
          maxAssets: 25000,
          maxDashboards: 400,
          maxRuleChains: 300,
          dataRetentionDays: 1825, // 5 years
          features: [
            'advancedAnalytics',
            'smartGrid',
            'energyForecasting',
            'loadManagement',
            'outageDetection',
            'mlPredictions',
            'customReports',
          ],
        },
        isolationMode: 'full',
      },

      // ========================================
      // 11. DEMO & TESTING TENANTS
      // ========================================
      {
        name: 'demo-tenant',
        title: 'Demo Corporation',
        description:
          'Demo tenant for testing, proof of concept, and client demonstrations',
        email: 'demo@smartlife.sa',
        phone: '+966112345699',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Digital Innovation Hub',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        additionalInfo: {
          logo: 'https://cdn.smartlife.sa/logos/demo.png',
          website: 'https://demo.smartlife.sa',
          industry: 'Demo & Testing',
          employeeCount: 10,
        },
        configuration: {
          maxDevices: 100,
          maxUsers: 10,
          maxCustomers: 10,
          maxAssets: 50,
          maxDashboards: 10,
          maxRuleChains: 5,
          dataRetentionDays: 90,
          features: ['advancedAnalytics', 'apiAccess'],
        },
        isolationMode: 'shared',
      },

      // ========================================
      // 12. INACTIVE/SUSPENDED TENANTS
      // ========================================
      {
        name: 'legacy-tech-systems',
        title: 'Legacy Tech Systems',
        description:
          'Former client - account suspended pending contract renewal',
        email: 'admin@legacytech.sa',
        phone: '+966112345700',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Old Industrial Area',
        zip: '11523',
        status: TenantStatus.SUSPENDED,
        additionalInfo: {
          website: 'https://legacytech.sa',
          industry: 'Technology',
          employeeCount: 50,
        },
        configuration: {
          maxDevices: 200,
          maxUsers: 20,
          maxCustomers: 10,
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
        description: 'Inactive test tenant for development and QA purposes',
        email: 'test@inactive.smartlife.sa',
        phone: '+966112345701',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Test Environment',
        zip: '11564',
        status: TenantStatus.INACTIVE,
        additionalInfo: {
          industry: 'Testing',
          employeeCount: 0,
        },
        configuration: {
          maxDevices: 50,
          maxUsers: 5,
          maxCustomers: 5,
          maxAssets: 25,
          maxDashboards: 5,
          maxRuleChains: 3,
          dataRetentionDays: 30,
          features: [],
        },
        isolationMode: 'shared',
      },
    ];

    // ========================================
    // SEED TENANTS
    // ========================================
    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const tenantData of tenants) {
      try {
        const existing = await this.tenantRepository.findOne({
          where: { name: tenantData.name },
        });

        if (!existing) {
          // Validate tenant admin exists if provided
          if (tenantData.tenantAdminId) {
            const admin = await this.userRepository.findOne({
              where: { id: tenantData.tenantAdminId },
            });
            if (!admin) {
              this.logger.warn(
                `⚠️  Tenant admin ${tenantData.tenantAdminId} not found for tenant ${tenantData.name}. Creating without admin.`,
              );
              tenantData.tenantAdminId = '';
            }
          }

          const tenant = this.tenantRepository.create(tenantData as any);
          await this.tenantRepository.save(tenant);

          const statusDisplay = this.getStatusEmoji(tenantData.status);
          const industryDisplay = tenantData.additionalInfo?.industry || 'N/A';

          this.logger.log(
            `✅ Created tenant: ${tenantData.name.padEnd(35)} | ${statusDisplay} | ${industryDisplay}`,
          );
          createdCount++;
        } else {
          this.logger.log(`⏭️  Tenant already exists: ${tenantData.name}`);
          existingCount++;
        }
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed tenant ${tenantData.name}: ${error.message}`,
        );
        errorCount++;
      }
    }

    // ========================================
    // SUMMARY
    // ========================================
    this.logger.log('🎉 Tenant seeding completed!');
    this.logger.log(`   ✅ Tenants created: ${createdCount}`);
    this.logger.log(`   ⏭️  Tenants already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
    this.logger.log('');
    this.logger.log('📋 Tenant Statistics:');
    this.logger.log(
      `   - Active: ${tenants.filter((t) => t.status === TenantStatus.ACTIVE).length}`,
    );
    this.logger.log(
      `   - Inactive: ${tenants.filter((t) => t.status === TenantStatus.INACTIVE).length}`,
    );
    this.logger.log(
      `   - Suspended: ${tenants.filter((t) => t.status === TenantStatus.SUSPENDED).length}`,
    );
    this.logger.log('');
    this.logger.log('🏢 Industry Distribution:');
    const industries = tenants
      .map((t) => t.additionalInfo?.industry)
      .filter(Boolean);
    const uniqueIndustries = [...new Set(industries)];
    uniqueIndustries.forEach((industry) => {
      const count = industries.filter((i) => i === industry).length;
      this.logger.log(`   - ${industry}: ${count}`);
    });
  }

  /**
   * Helper: Get emoji for status
   */
  private getStatusEmoji(status: TenantStatus): string {
    const statusMap = {
      [TenantStatus.ACTIVE]: '🟢 Active',
      [TenantStatus.INACTIVE]: '🟡 Inactive',
      [TenantStatus.SUSPENDED]: '🔴 Suspended',
    };
    return statusMap[status] || status;
  }
}