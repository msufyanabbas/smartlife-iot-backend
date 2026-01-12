import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Customer,
  CustomerStatus,
} from '@modules/customers/entities/customers.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class CustomerSeeder implements ISeeder {
  private readonly logger = new Logger(CustomerSeeder.name);

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting customer seeding...');

    try {
      // ========================================
      // CHECK EXISTING CUSTOMERS
      // ========================================
      const existingCount = await this.customerRepository.count();
      if (existingCount > 0) {
        this.logger.warn(
          `⚠️  Found ${existingCount} existing customers. Skipping seeding to avoid duplicates.`,
        );
        return;
      }

      // ========================================
      // FETCH TENANTS
      // ========================================
      const tenants = await this.tenantRepository.find({
        where: { status: 'active' as any }, // Only active tenants
      });

      if (tenants.length === 0) {
        this.logger.error(
          '❌ No active tenants found. Please seed tenants first.',
        );
        return;
      }

      this.logger.log(`📊 Found ${tenants.length} active tenant(s)`);

      // ========================================
      // HELPER FUNCTIONS
      // ========================================
      const getRandomItem = <T>(array: T[]): T => {
        return array[Math.floor(Math.random() * array.length)];
      };

      const getRandomInt = (min: number, max: number): number => {
        return Math.floor(Math.random() * (max - min + 1)) + min;
      };

      // ========================================
      // SAMPLE DATA - SAUDI ARABIAN CONTEXT
      // ========================================
      const saudiCities = [
        { city: 'Riyadh', state: 'Riyadh Region' },
        { city: 'Jeddah', state: 'Makkah Region' },
        { city: 'Mecca', state: 'Makkah Region' },
        { city: 'Medina', state: 'Al Madinah Region' },
        { city: 'Dammam', state: 'Eastern Province' },
        { city: 'Khobar', state: 'Eastern Province' },
        { city: 'Dhahran', state: 'Eastern Province' },
        { city: 'Tabuk', state: 'Tabuk Region' },
        { city: 'Buraidah', state: 'Al-Qassim Region' },
        { city: 'Abha', state: 'Asir Region' },
        { city: 'Yanbu', state: 'Al Madinah Region' },
        { city: 'Jubail', state: 'Eastern Province' },
        { city: 'Hail', state: 'Hail Region' },
        { city: 'Najran', state: 'Najran Region' },
        { city: 'Al-Ahsa', state: 'Eastern Province' },
      ];

      const customerTypes = [
        'Residential',
        'Commercial',
        'Industrial',
        'Government',
        'Educational',
        'Healthcare',
        'Hospitality',
        'Retail',
        'Mixed-Use',
      ];

      const streetNames = [
        'King Fahd Road',
        'King Abdullah Road',
        'Prince Mohammed Bin Abdulaziz Street',
        'King Khalid Road',
        'Al Olaya Street',
        'Tahlia Street',
        'Al Malaz Street',
        'Al Muruj District',
        'Al Nakheel District',
        'Al Yasmin District',
        'Al Rabie District',
        'Industrial Area',
        'King Abdulaziz Road',
        'Northern Ring Road',
        'Eastern Ring Road',
      ];

      const companyPrefixes = [
        'Saudi',
        'Al-Riyadh',
        'Jeddah',
        'Eastern Province',
        'Makkah',
        'Medina',
        'Gulf',
        'Arabian',
        'Red Sea',
        'Najd',
        'Al-Khobar',
        'Tabuk',
        'Asir',
        'Al-Qassim',
        'Dhahran',
        'NEOM',
        'Vision 2030',
        'Green',
        'Jubail',
        'Yanbu',
      ];

      const companySuffixes = [
        'Smart Solutions',
        'Technologies',
        'Innovation Hub',
        'Industries',
        'Smart Systems',
        'Tech Solutions',
        'IoT Solutions',
        'Smart Homes',
        'Automation',
        'Technology Group',
        'Smart Buildings',
        'Industrial Complex',
        'Smart City Project',
        'Tech Park',
        'Buildings',
        'Automation Systems',
        'Smart Living',
        'Digital Solutions',
        'Connected Systems',
        'Smart Facilities',
      ];

      const industrySegments = [
        'Manufacturing',
        'Real Estate',
        'Energy',
        'Technology',
        'Healthcare',
        'Education',
        'Retail',
        'Hospitality',
        'Transportation',
        'Telecommunications',
        'Financial Services',
        'Government',
        'Construction',
        'Agriculture',
      ];

      const saudiNames = [
        'Ahmed',
        'Mohammed',
        'Fatima',
        'Sara',
        'Ali',
        'Noura',
        'Abdullah',
        'Maha',
        'Khalid',
        'Reem',
        'Omar',
        'Layla',
        'Fahad',
        'Aisha',
        'Yusuf',
      ];

      const saudiSurnames = [
        'Al-Otaibi',
        'Al-Ghamdi',
        'Al-Qahtani',
        'Al-Dosari',
        'Al-Harbi',
        'Al-Zahrani',
        'Al-Shehri',
        'Al-Mutairi',
        'Al-Rasheed',
        'Al-Subaie',
        'Al-Malki',
        'Al-Anzi',
        'Al-Juhani',
        'Al-Enezi',
        'Al-Khatib',
      ];

      const customers: Partial<Customer>[] = [];

      // ========================================
      // GENERATE CUSTOMERS PER TENANT
      // ========================================
      for (const tenant of tenants) {
        const customersPerTenant = getRandomInt(4, 7); // 4-7 customers per tenant

        for (let i = 0; i < customersPerTenant; i++) {
          const location = getRandomItem(saudiCities);
          const streetName = getRandomItem(streetNames);
          const companyPrefix = getRandomItem(companyPrefixes);
          const companySuffix = getRandomItem(companySuffixes);
          const companyName = `${companyPrefix} ${companySuffix}`;
          const customerType = getRandomItem(customerTypes);
          const buildingNumber = getRandomInt(1000, 9999);
          const floor = getRandomInt(1, 25);
          const unitNumber = getRandomInt(1, 100);

          // Status distribution: 85% active, 10% inactive, 5% suspended
          const randomStatus = Math.random();
          const status =
            randomStatus > 0.15
              ? CustomerStatus.ACTIVE
              : randomStatus > 0.05
                ? CustomerStatus.INACTIVE
                : CustomerStatus.SUSPENDED;

          const isPublic = Math.random() > 0.7; // 30% public

          // Generate Saudi phone number
          const phonePrefix = getRandomItem([
            '050',
            '053',
            '054',
            '055',
            '056',
            '058',
            '059',
          ]);
          const phoneNumber = `+966${phonePrefix}${getRandomInt(1000000, 9999999)}`;

          // Generate email
          const emailDomain = getRandomItem([
            'smartlife.sa',
            'iot-solutions.sa',
            'automation.com.sa',
            'tech.sa',
            'sa.com',
          ]);
          const emailName = companyName
            .toLowerCase()
            .replace(/\s+/g, '.')
            .replace(/[^a-z0-9.]/g, '');
          const email = `contact@${emailName}.${emailDomain}`;

          // Additional info
          const industrySegment = getRandomItem(industrySegments);
          const accountManager = `${getRandomItem(saudiNames)} ${getRandomItem(saudiSurnames)}`;

          const additionalInfo: Record<string, any> = {
            customerType,
            industrySegment,
            employeeCount: getRandomItem([
              '1-10',
              '11-50',
              '51-200',
              '201-500',
              '500+',
            ]),
            annualRevenue: getRandomItem([
              'Under 1M SAR',
              '1M-5M SAR',
              '5M-20M SAR',
              '20M-100M SAR',
              'Over 100M SAR',
            ]),
            preferredLanguage: getRandomItem(['ar', 'en', 'both']),
            taxId: `3${getRandomInt(100000000, 999999999)}`, // Saudi Tax Number format
            commercialRegistration: `10${getRandomInt(10000000, 99999999)}`,
            contractStartDate: new Date(
              2024,
              getRandomInt(0, 11),
              getRandomInt(1, 28),
            ).toISOString(),
            contractEndDate: new Date(
              2025,
              getRandomInt(0, 11),
              getRandomInt(1, 28),
            ).toISOString(),
            contractType: getRandomItem([
              'Annual',
              'Multi-Year',
              'Project-Based',
              'Monthly',
            ]),
            paymentTerms: getRandomItem(['Net 30', 'Net 60', 'Prepaid']),
            billingCycle: getRandomItem(['monthly', 'quarterly', 'annually']),
            accountManager,
            priorityLevel: getRandomItem(['Standard', 'High', 'Critical']),
            slaLevel: getRandomItem([
              'Basic',
              'Standard',
              'Premium',
              'Enterprise',
            ]),
            notes: getRandomItem([
              'VIP customer - priority support required',
              'Large enterprise account with multiple locations',
              'Growing startup with expansion plans',
              'Government sector client - compliance critical',
              'Strategic partner for regional expansion',
              'Key account - regular business reviews',
              'Long-term client - excellent relationship',
              'New customer - onboarding in progress',
            ]),
          };

          customers.push({
            title: companyName,
            country: 'Saudi Arabia',
            state: location.state,
            city: location.city,
            address: `${buildingNumber} ${streetName}`,
            address2: `Floor ${floor}, Unit ${unitNumber}`,
            zip: `${getRandomInt(10000, 99999)}`,
            phone: phoneNumber,
            email: email,
            status: status,
            tenantId: tenant.id,
            description: `${customerType} customer in ${location.city}, specializing in ${industrySegment.toLowerCase()}. ${getRandomItem([
              'Leading provider of IoT solutions in the region.',
              'Committed to digital transformation and innovation.',
              'Focused on sustainable and smart initiatives.',
              'Pioneer in automation and monitoring systems.',
              'Trusted partner for advanced technology solutions.',
            ])}`,
            additionalInfo: additionalInfo,
            isPublic: isPublic,
          });
        }
      }

      // ========================================
      // ADD SPECIAL/FLAGSHIP CUSTOMERS
      // ========================================
      const specialCustomers: Partial<Customer>[] = [
        {
          title: 'NEOM Smart City Initiative',
          country: 'Saudi Arabia',
          state: 'Tabuk Region',
          city: 'NEOM',
          address: 'NEOM Development Area',
          address2: 'Smart City District',
          zip: '71491',
          phone: '+966505000001',
          email: 'iot@neom.sa',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants[0].id,
          description:
            'Flagship smart city project implementing cutting-edge IoT solutions across the entire urban development. Part of Saudi Vision 2030.',
          additionalInfo: {
            customerType: 'Government',
            industrySegment: 'Smart City',
            projectScope: 'Full city automation',
            priorityLevel: 'Critical',
            slaLevel: 'Enterprise',
            contractType: 'Multi-Year',
            contractValue: 'Enterprise',
            employeeCount: '500+',
            accountManager: 'Mohammed Al-Rasheed',
            taxId: '3999999999',
            commercialRegistration: '1099999999',
          },
          isPublic: true,
        },
        {
          title: 'King Abdullah Financial District',
          country: 'Saudi Arabia',
          state: 'Riyadh Region',
          city: 'Riyadh',
          address: 'King Fahd Road',
          address2: 'KAFD Complex',
          zip: '12382',
          phone: '+966505000002',
          email: 'tech@kafd.sa',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants[0].id,
          description:
            'Major financial district requiring comprehensive building automation and smart office solutions for 50+ buildings.',
          additionalInfo: {
            customerType: 'Commercial',
            industrySegment: 'Financial Services',
            buildingCount: 50,
            priorityLevel: 'Critical',
            slaLevel: 'Enterprise',
            employeeCount: '500+',
            accountManager: 'Fatima Al-Zahrani',
          },
          isPublic: false,
        },
        {
          title: 'Saudi Aramco Industrial Park',
          country: 'Saudi Arabia',
          state: 'Eastern Province',
          city: 'Dhahran',
          address: 'Saudi Aramco Headquarters',
          address2: 'Industrial Automation Division',
          zip: '31311',
          phone: '+966505000003',
          email: 'automation@aramco.com',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants[0].id,
          description:
            'Leading energy company implementing industrial IoT solutions for enhanced operational efficiency, safety, and predictive maintenance.',
          additionalInfo: {
            customerType: 'Industrial',
            industrySegment: 'Energy',
            facilityCount: 100,
            priorityLevel: 'Critical',
            slaLevel: 'Enterprise',
            securityLevel: 'Maximum',
            employeeCount: '500+',
            accountManager: 'Abdullah Al-Qahtani',
          },
          isPublic: false,
        },
        {
          title: 'Riyadh Metro Smart Stations',
          country: 'Saudi Arabia',
          state: 'Riyadh Region',
          city: 'Riyadh',
          address: 'Metro Operations Center',
          address2: 'Central Control',
          zip: '11564',
          phone: '+966505000004',
          email: 'smartstations@riyadhmetro.sa',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants[0].id,
          description:
            'Smart metro system with IoT-enabled stations for passenger management, environmental monitoring, and facility automation.',
          additionalInfo: {
            customerType: 'Government',
            industrySegment: 'Transportation',
            stationCount: 85,
            priorityLevel: 'High',
            slaLevel: 'Premium',
            accountManager: 'Omar Al-Harbi',
          },
          isPublic: true,
        },
        {
          title: 'King Abdulaziz University Smart Campus',
          country: 'Saudi Arabia',
          state: 'Makkah Region',
          city: 'Jeddah',
          address: 'University Main Campus',
          address2: 'IT & Innovation Center',
          zip: '21589',
          phone: '+966505000005',
          email: 'smartcampus@kau.edu.sa',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants.length > 1 ? tenants[1].id : tenants[0].id,
          description:
            'Leading university implementing smart campus solutions including energy management, security, and facility automation.',
          additionalInfo: {
            customerType: 'Educational',
            industrySegment: 'Education',
            buildingCount: 150,
            studentCount: '80000+',
            priorityLevel: 'High',
            slaLevel: 'Premium',
            accountManager: 'Sara Al-Ghamdi',
          },
          isPublic: true,
        },
        {
          title: 'Red Sea Development Company',
          country: 'Saudi Arabia',
          state: 'Tabuk Region',
          city: 'Red Sea Coast',
          address: 'Red Sea Project Site',
          address2: 'Development Office',
          zip: '71491',
          phone: '+966505000006',
          email: 'iot@theredsea.sa',
          status: CustomerStatus.ACTIVE,
          tenantId: tenants.length > 2 ? tenants[2].id : tenants[0].id,
          description:
            'Luxury tourism destination with comprehensive smart infrastructure for resorts, facilities, and environmental monitoring.',
          additionalInfo: {
            customerType: 'Hospitality',
            industrySegment: 'Tourism',
            resortCount: 50,
            priorityLevel: 'Critical',
            slaLevel: 'Enterprise',
            sustainabilityFocus: true,
            accountManager: 'Khalid Al-Otaibi',
          },
          isPublic: false,
        },
      ];

      // Add special customers
      customers.push(...specialCustomers);

      // ========================================
      // SAVE CUSTOMERS IN BATCHES
      // ========================================
      this.logger.log(`💾 Saving ${customers.length} customers...`);

      const batchSize = 50;
      let saved = 0;
      let errorCount = 0;

      for (let i = 0; i < customers.length; i += batchSize) {
        try {
          const batch = customers.slice(i, i + batchSize);
          const entities = this.customerRepository.create(batch);
          await this.customerRepository.save(entities);
          saved += batch.length;

          this.logger.log(`   📝 Saved ${saved}/${customers.length} customers`);
        } catch (error) {
          this.logger.error(
            `   ❌ Failed to save batch ${i / batchSize + 1}: ${error.message}`,
          );
          errorCount += Math.min(batchSize, customers.length - i);
        }
      }

      this.logger.log(`✅ Successfully created ${saved} customers`);
      if (errorCount > 0) {
        this.logger.warn(`⚠️  Failed to create ${errorCount} customers`);
      }

      // ========================================
      // STATISTICS
      // ========================================
      const stats = {
        total: saved,
        byStatus: {} as Record<string, number>,
        byCity: {} as Record<string, number>,
        byCustomerType: {} as Record<string, number>,
        byIndustry: {} as Record<string, number>,
        publicCustomers: customers.filter((c) => c.isPublic).length,
        privateCustomers: customers.filter((c) => !c.isPublic).length,
      };

      for (const customer of customers) {
        // Status distribution
        const status = customer.status || 'unknown';
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

        // City distribution
        if (customer.city) {
          stats.byCity[customer.city] =
            (stats.byCity[customer.city] || 0) + 1;
        }

        // Customer type distribution
        const custType =
          customer.additionalInfo?.customerType || 'Unknown';
        stats.byCustomerType[custType] =
          (stats.byCustomerType[custType] || 0) + 1;

        // Industry distribution
        const industry =
          customer.additionalInfo?.industrySegment || 'Unknown';
        stats.byIndustry[industry] = (stats.byIndustry[industry] || 0) + 1;
      }

      // ========================================
      // PRINT STATISTICS
      // ========================================
      this.logger.log('');
      this.logger.log('🎉 Customer seeding completed!');
      this.logger.log('');
      this.logger.log('📊 Customer Statistics:');
      this.logger.log(`   Total Customers: ${stats.total}`);
      this.logger.log(`   Public Customers: ${stats.publicCustomers}`);
      this.logger.log(`   Private Customers: ${stats.privateCustomers}`);
      this.logger.log('');
      this.logger.log('📈 Status Distribution:');
      Object.entries(stats.byStatus)
        .sort(([, a], [, b]) => b - a)
        .forEach(([status, count]) => {
          const emoji =
            status === CustomerStatus.ACTIVE
              ? '🟢'
              : status === CustomerStatus.INACTIVE
                ? '🟡'
                : '🔴';
          this.logger.log(`   ${emoji} ${status}: ${count}`);
        });
      this.logger.log('');
      this.logger.log('🏢 Customer Type Distribution:');
      Object.entries(stats.byCustomerType)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([type, count]) => {
          this.logger.log(`   - ${type}: ${count}`);
        });
      this.logger.log('');
      this.logger.log('🏭 Industry Distribution:');
      Object.entries(stats.byIndustry)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([industry, count]) => {
          this.logger.log(`   - ${industry}: ${count}`);
        });
      this.logger.log('');
      this.logger.log('🌍 Top Cities:');
      Object.entries(stats.byCity)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([city, count]) => {
          this.logger.log(`   - ${city}: ${count}`);
        });
    } catch (error) {
      this.logger.error('❌ Error seeding customers:', error.message);
      throw error;
    }
  }
}