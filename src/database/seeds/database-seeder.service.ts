import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SEEDERS } from './index.seeder';

@Injectable()
export class DatabaseSeederService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async seedAll(): Promise<void> {
    console.log('\n🌱 Starting database seeding...\n');

    try {
      for (const config of SEEDERS) {
        console.log(`${config.emoji} Seeding ${config.name.toLowerCase()}...`);

        // Dynamically resolve the seeder instance from NestJS DI container
        const seederInstance = this.moduleRef.get(config.seeder, {
          strict: false,
        });

        await seederInstance.seed();
      }

      console.log('\n✅ Database seeding completed successfully!\n');
    } catch (error) {
      console.error('\n❌ Database seeding failed:', error.message);
      process.exitCode = 1;
      throw error;
    }
  }

  /**
   * Seed a specific seeder by name
   * @param seederName - The name of the seeder (e.g., 'Users', 'Tenants')
   */
  async seedOne(seederName: string): Promise<void> {
    const config = SEEDERS.find(
      (s) => s.name.toLowerCase() === seederName.toLowerCase(),
    );

    if (!config) {
      throw new Error(`Seeder "${seederName}" not found`);
    }

    console.log(`\n🌱 Seeding ${config.name.toLowerCase()}...\n`);

    try {
      const seederInstance = this.moduleRef.get(config.seeder, {
        strict: false,
      });
      await seederInstance.seed();

      console.log(`\n✅ ${config.name} seeded successfully!\n`);
    } catch (error) {
      console.error(`\n❌ ${config.name} seeding failed:`, error.message);
      throw error;
    }
  }
}
