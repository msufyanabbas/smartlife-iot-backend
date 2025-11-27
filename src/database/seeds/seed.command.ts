import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { DatabaseSeederService } from './database-seeder.service';
import { Logger } from '@nestjs/common';

async function bootstrap(): Promise<void> {
  const logger = new Logger('SeedCommand');

  try {
    logger.log('🚀 Starting seed process...');

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    const seeder = app.get(DatabaseSeederService);

    await seeder.seedAll();

    await app.close();

    logger.log('✅ Seed process completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Seeding failed:', error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Fatal error during seeding:', error);
    process.exit(1);
  });
}

export { bootstrap };