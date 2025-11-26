import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { DatabaseSeederService } from './database-seeder.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const seeder = app.get(DatabaseSeederService);

  try {
    await seeder.seedAll();
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error);
    await app.close();
    process.exit(1);
  }
}

bootstrap();
