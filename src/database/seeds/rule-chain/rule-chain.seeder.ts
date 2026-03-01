// src/database/seeders/rule-chain/rule-chain.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuleChain, Tenant, User } from '@modules/index.entities';
import { RuleChainStatus } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class RuleChainSeeder implements ISeeder {
    private readonly logger = new Logger(RuleChainSeeder.name);

    constructor(
        @InjectRepository(RuleChain)
        private readonly ruleChainRepository: Repository<RuleChain>,
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        @InjectRepository(Tenant)
        private readonly tenantRepository: Repository<Tenant>,
    ) { }

    async seed(): Promise<void> {
        this.logger.log('🌱 Starting rule chain seeding...');

        const tenant = await this.tenantRepository.findOne({
            where: {},
            order: { createdAt: 'ASC' },
        });

        if (!tenant) {
            this.logger.warn('⚠️  No tenants found. Please seed tenants first.');
            return;
        }

        const user = await this.userRepository.findOne({
            where: { tenantId: tenant.id },
            order: { createdAt: 'ASC' },
        });

        if (!user) {
            this.logger.warn('⚠️  No users found. Please seed users first.');
            return;
        }

        const ruleChainsData = [
            // 1. Root telemetry processing chain
            {
                tenantId: tenant.id,
                userId: user.id,
                name: 'Device Telemetry Processing',
                description: 'Root rule chain for processing incoming device telemetry data',
                status: RuleChainStatus.ACTIVE,
                isRoot: true,
                enabled: true,
                debugMode: false,
                configuration: {
                    messageTypes: ['TELEMETRY'],
                    deviceTypes: ['sensor', 'gateway'],
                    maxExecutionTime: 5000,
                    retryOnFailure: true,
                    maxRetries: 3,
                },
                tags: ['telemetry', 'root', 'processing'],
                additionalInfo: {
                    version: '1.0.0',
                    author: 'system',
                },
            },

            // 2. Alarm handler chain
            {
                tenantId: tenant.id,
                userId: user.id,
                name: 'Alarm Handler',
                description: 'Processes and routes alarm events to appropriate notification channels',
                status: RuleChainStatus.ACTIVE,
                isRoot: false,
                enabled: true,
                debugMode: false,
                configuration: {
                    messageTypes: ['ALARM'],
                    maxExecutionTime: 3000,
                    retryOnFailure: true,
                    maxRetries: 2,
                },
                tags: ['alarm', 'notifications', 'critical'],
                additionalInfo: {
                    version: '1.0.0',
                    author: 'system',
                },
            },

            // 3. Asset attribute update chain
            {
                tenantId: tenant.id,
                userId: user.id,
                name: 'Asset Attribute Update',
                description: 'Handles attribute updates from devices and propagates them to linked assets',
                status: RuleChainStatus.ACTIVE,
                isRoot: false,
                enabled: true,
                debugMode: false,
                configuration: {
                    messageTypes: ['ATTRIBUTE'],
                    deviceTypes: ['sensor', 'actuator'],
                    assetTypes: ['building', 'floor', 'room'],
                    maxExecutionTime: 2000,
                    retryOnFailure: false,
                },
                tags: ['attributes', 'assets', 'sync'],
                additionalInfo: {
                    version: '1.0.0',
                    author: 'system',
                },
            },

            // 4. Energy monitoring chain (draft)
            {
                tenantId: tenant.id,
                userId: user.id,
                name: 'Energy Monitoring',
                description: 'Tracks energy consumption metrics and triggers alerts on anomalies',
                status: RuleChainStatus.DRAFT,
                isRoot: false,
                enabled: false,
                debugMode: true,
                configuration: {
                    messageTypes: ['TELEMETRY'],
                    deviceTypes: ['energy-meter', 'smart-plug'],
                    maxExecutionTime: 4000,
                    retryOnFailure: true,
                    maxRetries: 2,
                },
                tags: ['energy', 'monitoring', 'draft'],
                additionalInfo: {
                    version: '0.1.0',
                    author: 'system',
                    notes: 'Work in progress — thresholds not yet configured',
                },
            },

            // 5. Device lifecycle chain
            {
                tenantId: tenant.id,
                userId: user.id,
                name: 'Device Lifecycle Events',
                description: 'Handles device connect, disconnect, and status change events',
                status: RuleChainStatus.ACTIVE,
                isRoot: false,
                enabled: true,
                debugMode: false,
                configuration: {
                    messageTypes: ['CONNECT', 'DISCONNECT', 'ACTIVITY'],
                    maxExecutionTime: 1000,
                    retryOnFailure: false,
                },
                tags: ['lifecycle', 'connectivity', 'status'],
                additionalInfo: {
                    version: '1.0.0',
                    author: 'system',
                },
            },
        ];

        let createdCount = 0;
        let skippedCount = 0;

        for (const ruleChainData of ruleChainsData) {
            const existing = await this.ruleChainRepository.findOne({
                where: {
                    name: ruleChainData.name,
                    tenantId: ruleChainData.tenantId,
                },
            });

            if (!existing) {
                const ruleChain = this.ruleChainRepository.create(ruleChainData);
                await this.ruleChainRepository.save(ruleChain);
                this.logger.log(`✅ Created rule chain: ${ruleChainData.name} (${ruleChainData.status})`);
                createdCount++;
            } else {
                this.logger.log(`⏭️  Rule chain already exists: ${ruleChainData.name}`);
                skippedCount++;
            }
        }

        this.logger.log(`🎉 Rule chain seeding completed! Created: ${createdCount}, Skipped: ${skippedCount}`);
    }
}