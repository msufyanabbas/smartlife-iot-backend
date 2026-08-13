// src/database/seeds/edge/edge.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { Edge, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds one set of example edge gateways per tenant.
 *
 * Note on credentials: `edgeKey` is UNIQUE and the previous seeder never set it,
 * so every insert failed the NOT NULL constraint and the table stayed empty.
 * Here each edge is issued a key plus a hashed secret, exactly as
 * `EdgeService.activate()` would — so seeded edges are ready for an agent to
 * connect to without a manual activation step. The raw secrets are printed once
 * at seed time; they are not recoverable afterwards.
 */
@Injectable()
export class EdgeSeeder implements ISeeder {
  private readonly logger = new Logger(EdgeSeeder.name);

  constructor(
    @InjectRepository(Edge)
    private readonly edgeRepository: Repository<Edge>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting edge seeding...');

    const existing = await this.edgeRepository.count();
    if (existing > 0) {
      this.logger.log(
        `⏭️  Edges already seeded (${existing} records). Skipping...`,
      );
      return;
    }

    const tenants = await this.tenantRepository.find({ take: 3 });
    if (tenants.length === 0) {
      this.logger.warn('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const templates: Array<Partial<Edge>> = [
      {
        name: 'Riyadh Factory Gateway',
        description: 'Industrial edge gateway for Riyadh manufacturing plant',
        type: 'INDUSTRIAL',
        status: 'inactive',
        location: 'Riyadh Industrial City, Building A',
        latitude: 24.7136,
        longitude: 46.6753,
        syncConfig: {
          syncRules: true,
          syncDashboards: true,
          syncDevices: true,
          syncInterval: 300,
          offlineBufferHours: 48,
        },
        tags: ['factory', 'riyadh', 'industrial'],
      },
      {
        name: 'Smart Building Edge',
        description: 'Edge gateway for commercial building automation',
        type: 'GATEWAY',
        status: 'inactive',
        location: 'King Fahd Road, Riyadh',
        latitude: 24.7244,
        longitude: 46.638,
        syncConfig: {
          syncRules: true,
          syncDashboards: true,
          syncDevices: true,
          syncInterval: 60,
          offlineBufferHours: 24,
        },
        tags: ['building', 'automation'],
      },
      {
        name: 'Farm Edge Controller',
        description: 'Agricultural edge for remote farm monitoring',
        type: 'AGRICULTURE',
        status: 'inactive',
        location: 'Al-Qassim Region',
        latitude: 26.3,
        longitude: 43.9,
        syncConfig: {
          syncRules: true,
          syncDashboards: false,
          syncDevices: true,
          syncInterval: 600,
          offlineBufferHours: 72,
        },
        tags: ['farm', 'agriculture', 'remote'],
      },
    ];

    let created = 0;

    for (const tenant of tenants) {
      const owner =
        (await this.userRepository.findOne({ where: { tenantId: tenant.id } })) ??
        (await this.userRepository.findOne({ where: {} }));

      if (!owner) {
        this.logger.warn('⚠️  No users found. Please seed users first.');
        return;
      }

      for (const template of templates) {
        try {
          const rawSecret = randomBytes(32).toString('hex');
          const edge = this.edgeRepository.create({
            ...template,
            tenantId: tenant.id,
            userId: owner.id,
            createdBy: owner.id,
            edgeKey: `edge_${randomBytes(16).toString('hex')}`,
            edgeSecret: createHash('sha256').update(rawSecret).digest('hex'),
            connectedDeviceCount: 0,
            messagesPerMinute: 0,
            uptimePercentage: 0,
            totalMessagesProcessed: 0,
          });

          const saved = await this.edgeRepository.save(edge);
          created++;

          this.logger.log(
            `✅ Created: ${(saved.name ?? '').padEnd(26)} | ${String(saved.type).padEnd(12)} | ` +
              `key=${saved.edgeKey} secret=${rawSecret.slice(0, 12)}… | tenant ${tenant.id.slice(0, 8)}`,
          );
        } catch (error: any) {
          this.logger.error(
            `❌ Failed to seed edge '${template.name}': ${error.message}`,
          );
        }
      }
    }

    this.logger.log('');
    this.logger.log(
      `🎉 Edge seeding complete! Created ${created} edge(s) across ${tenants.length} tenant(s).`,
    );
  }
}
