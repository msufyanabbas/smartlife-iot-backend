import { Injectable, Logger, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SEEDERS } from './index.seeder';
import { ISeeder } from './seeder.interface';

interface SeederConfig {
  name: string;
  emoji: string;
  seeder: Type<ISeeder>;
  dependencies?: string[];
}

@Injectable()
export class DatabaseSeederService {
  private readonly logger = new Logger(DatabaseSeederService.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Seed all registered seeders in order
   */
  async seedAll(): Promise<void> {
    this.logger.log('\n🌱 Starting database seeding...\n');

    try {
      for (const config of SEEDERS as SeederConfig[]) {
        this.logger.log(`${config.emoji} Seeding ${config.name.toLowerCase()}...`);

        // Dynamically resolve the seeder instance from NestJS DI container
        const seederInstance = this.moduleRef.get<ISeeder>(config.seeder, {
          strict: false,
        });

        await seederInstance.seed();
      }

      this.logger.log('\n✅ Database seeding completed successfully!\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('\n❌ Database seeding failed:', errorMessage);
      
      if (error instanceof Error && error.stack) {
        this.logger.error(error.stack);
      }
      
      process.exitCode = 1;
      throw error;
    }
  }

  /**
   * Seed a specific seeder by name
   * @param seederName - The name of the seeder (e.g., 'Users', 'Tenants')
   */
  async seedOne(seederName: string): Promise<void> {
    const config = (SEEDERS as SeederConfig[]).find(
      (s) => s.name.toLowerCase() === seederName.toLowerCase(),
    );

    if (!config) {
      throw new Error(`Seeder "${seederName}" not found`);
    }

    this.logger.log(`\n🌱 Seeding ${config.name.toLowerCase()}...\n`);

    try {
      const seederInstance = this.moduleRef.get<ISeeder>(config.seeder, {
        strict: false,
      });
      
      await seederInstance.seed();

      this.logger.log(`\n✅ ${config.name} seeded successfully!\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`\n❌ ${config.name} seeding failed:`, errorMessage);
      
      if (error instanceof Error && error.stack) {
        this.logger.error(error.stack);
      }
      
      throw error;
    }
  }

  /**
   * Get list of all available seeders
   */
  getAvailableSeeders(): string[] {
    return (SEEDERS as SeederConfig[]).map((s) => s.name);
  }
}