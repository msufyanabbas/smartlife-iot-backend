// src/database/seeds/script/script.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScriptType } from '@common/enums/index.enum';
import { Script, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

/**
 * ThingsBoard-style example scripts, one set per tenant.
 *
 * Every script is written in the named-entry-point style
 * (`function Filter(msg, metadata, msgType)`) because that is what the
 * ThingsBoard docs show; the executor equally accepts a bare function body with
 * a top-level `return`.
 */
@Injectable()
export class ScriptSeeder implements ISeeder {
  private readonly logger = new Logger(ScriptSeeder.name);

  constructor(
    @InjectRepository(Script)
    private readonly scriptRepository: Repository<Script>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting script seeding...');

    const existing = await this.scriptRepository.count();
    if (existing > 0) {
      this.logger.log(
        `⏭️  Scripts already seeded (${existing} records). Skipping...`,
      );
      return;
    }

    const tenants = await this.tenantRepository.find({ take: 5 });
    if (tenants.length === 0) {
      this.logger.warn('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const templates: Array<Partial<Script>> = [
      {
        name: 'Temperature Filter',
        description: 'Only pass messages where temperature > 30°C',
        type: ScriptType.FILTER,
        code: `function Filter(msg, metadata, msgType) {
  return msg.temperature !== undefined && msg.temperature > 30;
}`,
      },
      {
        name: 'Celsius to Fahrenheit',
        description: 'Convert temperature from Celsius to Fahrenheit',
        type: ScriptType.TRANSFORMATION,
        code: `function Transform(msg, metadata, msgType) {
  if (msg.temperature !== undefined) {
    msg.temperatureF = (msg.temperature * 9/5) + 32;
    msg.temperatureOriginal = msg.temperature;
  }
  return { msg: msg, metadata: metadata, msgType: msgType };
}`,
      },
      {
        name: 'Add Device Metadata',
        description: 'Enrich message with platform and region metadata',
        type: ScriptType.ENRICHMENT,
        code: `function Enrich(msg, metadata, msgType) {
  return {
    processedAt: new Date().toISOString(),
    platform: 'SmartLife IoT',
    region: 'Saudi Arabia',
  };
}`,
      },
      {
        name: 'Validate Sensor Data',
        description: 'Validate that sensor readings are within acceptable ranges',
        type: ScriptType.VALIDATION,
        code: `function Validate(msg, metadata, msgType) {
  if (msg.temperature !== undefined) {
    if (msg.temperature < -50 || msg.temperature > 100) {
      return { valid: false, error: 'Temperature out of range: ' + msg.temperature };
    }
  }
  if (msg.humidity !== undefined) {
    if (msg.humidity < 0 || msg.humidity > 100) {
      return { valid: false, error: 'Humidity out of range: ' + msg.humidity };
    }
  }
  return { valid: true };
}`,
      },
      {
        name: 'High Temperature Alert Transform',
        description: 'Tag the message with an alert level based on temperature',
        type: ScriptType.TRANSFORMATION,
        code: `function Transform(msg, metadata, msgType) {
  var temp = msg.temperature;
  if (temp !== undefined) {
    if (temp > 40) {
      msg.alertLevel = 'CRITICAL';
      msg.alertMessage = 'Critical temperature: ' + temp + '°C';
    } else if (temp > 35) {
      msg.alertLevel = 'WARNING';
      msg.alertMessage = 'High temperature: ' + temp + '°C';
    } else {
      msg.alertLevel = 'NORMAL';
    }
  }
  return { msg: msg, metadata: metadata, msgType: msgType };
}`,
      },
    ];

    let created = 0;

    for (const tenant of tenants) {
      // userId is NOT NULL; fall back to any user when the tenant has none.
      const owner =
        (await this.userRepository.findOne({
          where: { tenantId: tenant.id },
        })) ?? (await this.userRepository.findOne({ where: {} }));

      if (!owner) {
        this.logger.warn('⚠️  No users found. Please seed users first.');
        return;
      }

      for (const template of templates) {
        try {
          const script = this.scriptRepository.create({
            ...template,
            tenantId: tenant.id,
            userId: owner.id,
            createdBy: owner.id,
            language: 'javascript',
            version: '1.0.0',
            timeout: 3000,
            isSystem: true,
            lines: (template.code ?? '').split('\n').length,
            lastModified: new Date(),
          });

          await this.scriptRepository.save(script);
          created++;

          this.logger.log(
            `✅ Created: ${(script.name ?? '').padEnd(34)} | ${script.type.padEnd(15)} | tenant ${tenant.id.slice(0, 8)}`,
          );
        } catch (error: any) {
          this.logger.error(
            `❌ Failed to seed script '${template.name}': ${error.message}`,
          );
        }
      }
    }

    this.logger.log('');
    this.logger.log(
      `🎉 Script seeding complete! Created ${created} scripts across ${tenants.length} tenant(s).`,
    );
  }
}
