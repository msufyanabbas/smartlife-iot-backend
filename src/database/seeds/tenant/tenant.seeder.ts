// src/database/seeds/tenant/tenant.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '@modules/index.entities';
import { TenantStatus } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class TenantSeeder implements ISeeder {
  private readonly logger = new Logger(TenantSeeder.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting tenant seeding...');

    const tenants: Partial<Tenant>[] = [
      {
        name: 'smart-life-platform',
        email: 'admin@smartlife.sa',
        phone: '+966112345678',
        logo: 'https://cdn.smartlife.sa/logos/smart-life-platform.png',
        website: 'https://smartlife.sa',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'King Fahd Road, Al Olaya District',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'en',
          theme: 'dark',
        },
      },
      {
        name: 'riyadh-smart-city',
        email: 'iot@riyadhcity.gov.sa',
        phone: '+966114567890',
        logo: 'https://cdn.smartlife.sa/logos/riyadh-smart-city.png',
        website: 'https://riyadhcity.gov.sa',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Imam Abdullah bin Saud Road',
        zip: '11461',
        status: TenantStatus.ACTIVE,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'ar',
          theme: 'light',
        },
      },
      {
        name: 'neom-smart-infrastructure',
        email: 'iot@neom.sa',
        phone: '+966114567891',
        logo: 'https://cdn.smartlife.sa/logos/neom.png',
        website: 'https://neom.sa',
        country: 'Saudi Arabia',
        state: 'Tabuk Region',
        city: 'NEOM',
        address: 'NEOM Bay',
        zip: '49643',
        status: TenantStatus.ACTIVE,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'en',
          theme: 'dark',
        },
      },
      {
        name: 'al-hokair-properties',
        email: 'iot@alhokair.com.sa',
        phone: '+966112345679',
        logo: 'https://cdn.smartlife.sa/logos/al-hokair.png',
        website: 'https://alhokair.com.sa',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Al Olaya Street',
        zip: '11543',
        status: TenantStatus.ACTIVE,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'en',
          theme: 'light',
        },
      },
      {
        name: 'demo-tenant',
        email: 'demo@smartlife.sa',
        phone: '+966112345699',
        logo: 'https://cdn.smartlife.sa/logos/demo.png',
        website: 'https://demo.smartlife.sa',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Digital Innovation Hub',
        zip: '11564',
        status: TenantStatus.ACTIVE,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'en',
          theme: 'light',
        },
      },
      {
        name: 'legacy-tech-systems',
        email: 'admin@legacytech.sa',
        phone: '+966112345700',
        website: 'https://legacytech.sa',
        country: 'Saudi Arabia',
        state: 'Riyadh Region',
        city: 'Riyadh',
        address: 'Old Industrial Area',
        zip: '11523',
        status: TenantStatus.SUSPENDED,
        configuration: {
          timezone: 'Asia/Riyadh',
          language: 'en',
          theme: 'light',
        },
      },
    ];

    let createdCount = 0;
    let existingCount = 0;
    let errorCount = 0;

    for (const tenantData of tenants) {
      try {
        if (!tenantData.name) {
          this.logger.warn('⚠️ Skipping tenant entry with missing name.');
          continue;
        }

        const existing = await this.tenantRepository.findOne({
          where: { name: tenantData.name },
        });

        if (!existing) {
          const tenant = this.tenantRepository.create(tenantData);
          await this.tenantRepository.save(tenant);

          this.logger.log(
            `✅ Created tenant: ${tenantData.name.padEnd(35)} | Status: ${tenantData.status}`,
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

    this.logger.log('🎉 Tenant seeding completed!');
    this.logger.log(`   ✅ Tenants created: ${createdCount}`);
    this.logger.log(`   ⏭️  Tenants already existed: ${existingCount}`);
    if (errorCount > 0) {
      this.logger.log(`   ❌ Errors: ${errorCount}`);
    }
  }
}