import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { SolutionTemplate } from './entities/solution-template.entity';
import { TemplateInstallation } from './entities/template-installation.entity';
import { Device, DeviceProtocol } from '../devices/entities/device.entity';
import { DeviceCredentials, CredentialsType } from '../devices/entities/device-credentials.entity';
import { DeviceProfile } from '../profiles/entities/device-profile.entity';
import { Dashboard } from '../dashboards/entities/dashboard.entity';
import { RuleChain } from '../rules/entities/rule-chain.entity';
import { Node } from '../nodes/entities/node.entity';
import { Alarm } from '../alarms/entities/alarm.entity';

import {
  SolutionTemplateCategory as TemplateCategory,
  DeviceStatus,
  DeviceType,
  RuleChainStatus,
  UserRole,
} from '@common/enums/index.enum';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';
import {
  InstallationStatus,
  type TemplateConfiguration,
  type InstallResult,
} from './interfaces/template-configuration.interface';

@Injectable()
export class SolutionTemplatesService {
  private readonly logger = new Logger(SolutionTemplatesService.name);

  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly templateRepository: Repository<SolutionTemplate>,
    @InjectRepository(TemplateInstallation)
    private readonly installationRepo: Repository<TemplateInstallation>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // VISIBILITY
  //
  // A template is visible to a tenant when it is a system template
  // (isSystem = true, tenantId IS NULL) or it belongs to that tenant.
  // Every read path funnels through this so no tenant can see another's
  // user-created templates.
  // ══════════════════════════════════════════════════════════════════════════

  private applyVisibility(
    qb: ReturnType<Repository<SolutionTemplate>['createQueryBuilder']>,
    tenantId: string,
  ) {
    return qb.andWhere(
      new Brackets((w) => {
        w.where('template.isSystem = true').orWhere(
          'template.tenantId = :tenantId',
          { tenantId },
        );
      }),
    );
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(
    userId: string,
    tenantId: string,
    createDto: CreateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    const template = this.templateRepository.create({
      ...createDto,
      tenantId, // ← from JWT, never from the body
      userId,
      createdBy: userId,
      isSystem: false, // user-created templates are never system templates
      rating: 0,
      ratings: {},
      ratingCount: 0,
      installs: 0,
    });

    const saved = await this.templateRepository.save(template);
    this.logger.log(`Solution template created: ${saved.id} by user ${userId}`);
    return saved;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async findAll(tenantId: string, filters?: FindAllTemplatesDto) {
    const { page = 1, limit = 12, search, category, isPremium } = filters || {};
    const skip = (page - 1) * limit;

    const qb = this.templateRepository.createQueryBuilder('template');
    this.applyVisibility(qb, tenantId);

    if (category) {
      qb.andWhere('template.category = :category', { category });
    }

    if (isPremium !== undefined) {
      qb.andWhere('template.isPremium = :isPremium', { isPremium });
    }

    if (search) {
      qb.andWhere(
        '(template.name ILIKE :search OR template.description ILIKE :search OR template.tags::text ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy('template.installs', 'DESC')
      .addOrderBy('template.rating', 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string, tenantId: string): Promise<SolutionTemplate> {
    const qb = this.templateRepository
      .createQueryBuilder('template')
      .where('template.id = :id', { id });
    this.applyVisibility(qb, tenantId);

    const template = await qb.getOne();
    if (!template) {
      throw new NotFoundException('Solution template not found');
    }
    return template;
  }

  // ── Update / Delete ───────────────────────────────────────────────────────

  async update(
    id: string,
    userId: string,
    tenantId: string,
    role: UserRole,
    updateDto: UpdateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    const template = await this.findOne(id, tenantId);

    if (template.isSystem && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot update system templates');
    }

    if (!template.isSystem && template.userId !== userId && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to update this template',
      );
    }

    Object.assign(template, updateDto);
    template.updatedBy = userId;
    template.lastUpdated = new Date();

    return await this.templateRepository.save(template);
  }

  async remove(
    id: string,
    userId: string,
    tenantId: string,
    role: UserRole,
  ): Promise<void> {
    const template = await this.findOne(id, tenantId);

    if (template.isSystem && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot delete system templates');
    }

    if (!template.isSystem && template.userId !== userId && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to delete this template',
      );
    }

    await this.templateRepository.softRemove(template);
    this.logger.log(`Solution template deleted: ${id} by user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRE-FLIGHT QUOTA CHECK
  //
  // Uses Subscription.getRemainingCapacity(), which reads the denormalised
  // usage counters and understands -1 = unlimited. Checked BEFORE the
  // transaction opens so we fail fast rather than rolling back work.
  // ══════════════════════════════════════════════════════════════════════════

  private async checkQuotas(
    tenantId: string,
    config: TemplateConfiguration,
  ): Promise<void> {
    const totalDevices =
      config.devices?.reduce((sum, d) => sum + (d.count ?? 0), 0) ?? 0;
    const totalDashboards = config.dashboards?.length ?? 0;

    if (totalDevices === 0 && totalDashboards === 0) return;

    const subscription = await this.subscriptionsService
      .findByTenantId(tenantId)
      .catch(() => null);

    if (!subscription) {
      throw new BadRequestException(
        'No active subscription found for this tenant — cannot install a template',
      );
    }

    const checks: Array<[number, 'devices' | 'dashboards', string]> = [
      [totalDevices, 'devices', 'devices'],
      [totalDashboards, 'dashboards', 'dashboards'],
    ];

    for (const [required, resource, label] of checks) {
      if (required <= 0) continue;
      const remaining = subscription.getRemainingCapacity(resource);
      if (required > remaining) {
        throw new BadRequestException(
          `Installing this template would create ${required} ${label}, ` +
            `but your plan has only ${remaining === Infinity ? 'unlimited' : remaining} remaining. ` +
            `Upgrade your plan or free up capacity first.`,
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INSTALL — real transactional provisioning
  // ══════════════════════════════════════════════════════════════════════════

  async install(
    id: string,
    userId: string,
    tenantId: string,
    customerId: string | undefined,
    dto: InstallTemplateDto,
  ): Promise<InstallResult> {
    const template = await this.findOne(id, tenantId);
    const config = (template.configuration ?? {}) as TemplateConfiguration;

    if (!config || Object.keys(config).length === 0) {
      throw new BadRequestException(
        'This template has no configuration to install',
      );
    }

    // 1. Idempotency — one successful install per template per tenant.
    //    MUST precede the quota check: a repeat install has already consumed
    //    its quota, so checking quota first reports a misleading
    //    "limit exceeded" instead of "already installed".
    const existing = await this.installationRepo.findOne({
      where: { tenantId, templateId: id, status: InstallationStatus.SUCCESS },
    });
    if (existing) {
      throw new ConflictException(
        `Template "${template.name}" is already installed. Installation ID: ${existing.id}`,
      );
    }

    // 2. Pre-flight quota check
    await this.checkQuotas(tenantId, config);

    const installName = dto.installationName ?? template.name;
    const customization = dto.customization ?? {};

    // 3. Installation record (outside the transaction so it survives a rollback)
    const installation = this.installationRepo.create({
      tenantId,
      customerId,
      templateId: id,
      userId,
      createdBy: userId,
      installationName: installName,
      status: InstallationStatus.INSTALLING,
      installedAt: new Date(),
      configuration: config,
      customization,
      createdDeviceIds: [],
      createdDashboardIds: [],
      createdRuleChainIds: [],
      createdAlarmIds: [],
    });
    await this.installationRepo.save(installation);

    // 4. Transactional provisioning
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const createdDeviceIds: string[] = [];
    const createdDashboardIds: string[] = [];
    const createdRuleChainIds: string[] = [];
    const createdAlarmIds: string[] = [];

    const applyPlaceholders = (value: string, index?: number): string =>
      value
        .replace(/\{n\}/g, index === undefined ? '' : String(index + 1))
        .replace(/\{installName\}/g, installName);

    try {
      // ── DEVICES ───────────────────────────────────────────────────────────
      for (const spec of config.devices ?? []) {
        if (!spec.count || spec.count < 1) continue;

        // Resolve the device profile once per spec, not once per device
        let deviceProfileId: string | undefined;
        if (spec.profileName) {
          const profile = await queryRunner.manager.findOne(DeviceProfile, {
            where: { name: spec.profileName, tenantId },
          });
          if (!profile) {
            this.logger.warn(
              `Device profile "${spec.profileName}" not found for tenant ${tenantId} — devices will be created without a profile`,
            );
          }
          deviceProfileId = profile?.id;
        }

        for (let i = 0; i < spec.count; i++) {
          const device = queryRunner.manager.create(Device, {
            // deviceKey is UNIQUE and NOT NULL — mirrors DevicesService.create()
            deviceKey: `dev_${crypto.randomBytes(8).toString('hex')}`,
            name: applyPlaceholders(spec.name, i),
            type: spec.type ?? DeviceType.SENSOR,
            status: spec.status ?? DeviceStatus.INACTIVE,
            protocol: spec.protocol ?? DeviceProtocol.GENERIC_MQTT,
            tenantId,
            userId,
            ...(customerId ? { customerId } : {}),
            ...(deviceProfileId ? { deviceProfileId } : {}),
            metadata: {
              ...(spec.codecId ? { codecId: spec.codecId } : {}),
              ...(spec.label
                ? { label: applyPlaceholders(spec.label, i) }
                : {}),
              ...(spec.defaultTelemetryKeys
                ? { defaultTelemetryKeys: spec.defaultTelemetryKeys }
                : {}),
              installedFromTemplate: id,
              templateName: template.name,
              installationId: installation.id,
            },
          });
          const savedDevice = await queryRunner.manager.save(device);

          const credentials = queryRunner.manager.create(DeviceCredentials, {
            deviceId: savedDevice.id,
            credentialsType: CredentialsType.ACCESS_TOKEN,
            credentialsId: crypto.randomBytes(20).toString('hex'),
            isActive: true,
          });
          await queryRunner.manager.save(credentials);

          createdDeviceIds.push(savedDevice.id);
        }
      }

      // ── DASHBOARDS ────────────────────────────────────────────────────────
      for (const dashSpec of config.dashboards ?? []) {
        const dashboard = queryRunner.manager.create(Dashboard, {
          // Dashboard's column is `name`, not `title`
          name: applyPlaceholders(dashSpec.name),
          description: dashSpec.description,
          tenantId,
          userId,
          ...(customerId ? { customerId } : {}),
          // Widgets live in their own top-level jsonb column
          widgets: (dashSpec.widgets ?? []).map((w) => ({
            id: crypto.randomUUID(),
            type: w.type,
            title: w.title,
            config: w.config ?? {},
            position: {
              row: w.row,
              col: w.col,
              width: w.width,
              height: w.height,
            },
          })) as any,
          settings: {
            installedFromTemplate: id,
            installationId: installation.id,
          } as any,
          createdBy: userId,
        });
        const savedDash = await queryRunner.manager.save(dashboard);
        createdDashboardIds.push(savedDash.id);
      }

      // ── RULE CHAINS + NODES ───────────────────────────────────────────────
      for (const chainSpec of config.ruleChains ?? []) {
        const chain = queryRunner.manager.create(RuleChain, {
          name: applyPlaceholders(chainSpec.name),
          description: chainSpec.description,
          tenantId,
          userId,
          ...(customerId ? { customerId } : {}),
          status: RuleChainStatus.ACTIVE,
          enabled: true,
          configuration: { messageTypes: chainSpec.messageTypes ?? [] },
          additionalInfo: {
            installedFromTemplate: id,
            installationId: installation.id,
          },
          createdBy: userId,
        });
        const savedChain = await queryRunner.manager.save(chain);
        createdRuleChainIds.push(savedChain.id);

        const nodeIds: string[] = [];
        for (const nodeSpec of chainSpec.nodes ?? []) {
          const node = queryRunner.manager.create(Node, {
            name: nodeSpec.name,
            type: nodeSpec.type,
            ruleChainId: savedChain.id,
            tenantId,
            userId, // Node.userId is NOT NULL
            ...(customerId ? { customerId } : {}),
            configuration: nodeSpec.configuration ?? {}, // NOT NULL
            position: nodeSpec.position ?? { x: 0, y: 0 },
            connections: [],
            createdBy: userId,
          });
          const savedNode = await queryRunner.manager.save(node);
          nodeIds.push(savedNode.id);
        }

        // Wire connections — group by source so a node with several outgoing
        // edges keeps all of them (a per-connection update would overwrite).
        const bySource = new Map<
          number,
          Array<{ targetNodeId: string; connectionType: string }>
        >();
        for (const conn of chainSpec.connections ?? []) {
          const from = nodeIds[conn.fromNodeIndex];
          const to = nodeIds[conn.toNodeIndex];
          if (!from || !to) {
            this.logger.warn(
              `Skipping invalid connection ${conn.fromNodeIndex}->${conn.toNodeIndex} in rule chain "${chainSpec.name}"`,
            );
            continue;
          }
          const list = bySource.get(conn.fromNodeIndex) ?? [];
          list.push({ targetNodeId: to, connectionType: conn.connectionType });
          bySource.set(conn.fromNodeIndex, list);
        }
        for (const [fromIndex, connections] of bySource) {
          await queryRunner.manager.update(
            Node,
            { id: nodeIds[fromIndex] },
            { connections: connections as any },
          );
        }

        if (nodeIds.length > 0) {
          await queryRunner.manager.update(
            RuleChain,
            { id: savedChain.id },
            { rootNodeId: nodeIds[0] },
          );
        }
      }

      // ── ALARMS ────────────────────────────────────────────────────────────
      if ((config.alarms ?? []).length > 0 && createdDeviceIds.length === 0) {
        this.logger.warn(
          `Template ${id} declares alarms but created no devices — alarms skipped`,
        );
      }

      for (const alarmSpec of config.alarms ?? []) {
        let targetDeviceIds: string[] = [];
        if (alarmSpec.deviceSelector === 'all') {
          targetDeviceIds = createdDeviceIds;
        } else if (alarmSpec.deviceSelector === 'first') {
          targetDeviceIds = createdDeviceIds.slice(0, 1);
        } else if (typeof alarmSpec.deviceSelector === 'number') {
          targetDeviceIds = createdDeviceIds.slice(0, alarmSpec.deviceSelector);
        }

        for (const deviceId of targetDeviceIds) {
          // NOTE: Alarm has no userId / additionalInfo columns — provenance
          // goes in `metadata`, ownership in `createdBy` (from BaseEntity).
          const alarm = queryRunner.manager.create(Alarm, {
            name: alarmSpec.name,
            tenantId,
            ...(customerId ? { customerId } : {}),
            deviceId,
            severity: alarmSpec.severity,
            rule: {
              telemetryKey: alarmSpec.telemetryKey,
              condition: alarmSpec.condition,
              value: alarmSpec.value,
              ...(alarmSpec.value2 !== undefined
                ? { value2: alarmSpec.value2 }
                : {}),
            },
            isEnabled: true,
            metadata: {
              installedFromTemplate: id,
              installationId: installation.id,
            },
            createdBy: userId,
          });
          const savedAlarm = await queryRunner.manager.save(alarm);
          createdAlarmIds.push(savedAlarm.id);
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      installation.status = InstallationStatus.FAILED;
      installation.error =
        error instanceof Error ? error.message : String(error);
      installation.completedAt = new Date();
      await this.installationRepo.save(installation);

      this.logger.error(
        `Template installation ${installation.id} failed and was rolled back: ${installation.error}`,
      );

      throw new InternalServerErrorException(
        `Template installation failed and was rolled back: ${installation.error}`,
      );
    } finally {
      await queryRunner.release();
    }

    // 5. Post-commit bookkeeping
    installation.status = InstallationStatus.SUCCESS;
    installation.completedAt = new Date();
    installation.createdDeviceIds = createdDeviceIds;
    installation.createdDashboardIds = createdDashboardIds;
    installation.createdRuleChainIds = createdRuleChainIds;
    installation.createdAlarmIds = createdAlarmIds;
    await this.installationRepo.save(installation);

    // Keep the denormalised quota counters honest — checkQuotas() reads these.
    if (createdDeviceIds.length) {
      await this.subscriptionsService.incrementTenantUsage(
        tenantId,
        'devices',
        createdDeviceIds.length,
      );
    }
    if (createdDashboardIds.length) {
      await this.subscriptionsService.incrementTenantUsage(
        tenantId,
        'dashboards',
        createdDashboardIds.length,
      );
    }

    template.installs += 1;
    await this.templateRepository.save(template);

    this.logger.log(
      `Template ${template.name} installed (${installation.id}): ` +
        `${createdDeviceIds.length} devices, ${createdDashboardIds.length} dashboards, ` +
        `${createdRuleChainIds.length} rule chains, ${createdAlarmIds.length} alarms`,
    );

    return {
      success: true,
      installationId: installation.id,
      installationName: installation.installationName,
      templateName: template.name,
      devicesCreated: createdDeviceIds.length,
      dashboardsCreated: createdDashboardIds.length,
      ruleChainsCreated: createdRuleChainIds.length,
      alarmsCreated: createdAlarmIds.length,
      deviceIds: createdDeviceIds,
      dashboardIds: createdDashboardIds,
      ruleChainIds: createdRuleChainIds,
      alarmIds: createdAlarmIds,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNINSTALL — best-effort teardown of everything an installation created
  //
  // Runs inside one transaction, but each resource group gets its own SAVEPOINT
  // so a failure in one group does not poison the rest. A plain try/catch would
  // not be enough here: in Postgres the first error aborts the whole
  // transaction and every subsequent statement fails with
  // "current transaction is aborted" — which would turn "best-effort" into
  // "all-or-nothing" without the savepoints.
  //
  // Deletes are soft (deleted_at), matching the platform-wide convention.
  // The installation is marked ROLLED_BACK whether or not every group
  // succeeded; any failures are recorded on `error` for later inspection.
  // ══════════════════════════════════════════════════════════════════════════

  async uninstall(
    installationId: string,
    tenantId: string,
  ): Promise<{ success: boolean; message: string; resourcesRemoved: number }> {
    // 1. Locate the installation — tenant-scoped, and only a successful install
    //    can be torn down (an INSTALLING/FAILED/ROLLED_BACK row has nothing to
    //    remove, or is already gone).
    const installation = await this.installationRepo.findOne({
      where: {
        id: installationId,
        tenantId,
        status: InstallationStatus.SUCCESS,
      },
    });

    if (!installation) {
      throw new NotFoundException(
        'Installation not found or already uninstalled',
      );
    }

    const deviceIds = installation.createdDeviceIds ?? [];
    const dashboardIds = installation.createdDashboardIds ?? [];
    const ruleChainIds = installation.createdRuleChainIds ?? [];
    const alarmIds = installation.createdAlarmIds ?? [];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let resourcesRemoved = 0;
    let devicesRemoved = 0;
    let dashboardsRemoved = 0;
    const failures: string[] = [];
    let savepointSeq = 0;

    /**
     * Runs one deletion group under its own savepoint.
     * Returns the number of rows affected, or 0 if the group failed.
     */
    const step = async (
      label: string,
      fn: () => Promise<number>,
    ): Promise<number> => {
      const savepoint = `sp_uninstall_${++savepointSeq}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      try {
        const affected = await fn();
        await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
        return affected;
      } catch (error) {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${message}`);
        this.logger.error(
          `Uninstall ${installationId} — failed to remove ${label}: ${message}`,
        );
        return 0;
      }
    };

    try {
      // ── DEVICES (+ their credentials) ─────────────────────────────────────
      if (deviceIds.length) {
        // Credentials first — they are dependents of the device and carry no
        // tenantId of their own, so they are scoped via deviceId.
        await step('device credentials', async () => {
          const result = await queryRunner.manager.softDelete(
            DeviceCredentials,
            { deviceId: In(deviceIds) },
          );
          return result.affected ?? 0;
        });

        devicesRemoved = await step('devices', async () => {
          const result = await queryRunner.manager.softDelete(Device, {
            id: In(deviceIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
        resourcesRemoved += devicesRemoved;
      }

      // ── DASHBOARDS ────────────────────────────────────────────────────────
      if (dashboardIds.length) {
        dashboardsRemoved = await step('dashboards', async () => {
          const result = await queryRunner.manager.softDelete(Dashboard, {
            id: In(dashboardIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
        resourcesRemoved += dashboardsRemoved;
      }

      // ── RULE CHAINS (+ their nodes) ───────────────────────────────────────
      if (ruleChainIds.length) {
        // Nodes are children of the chain; install() never records their ids
        // individually, so they are removed by ruleChainId.
        await step('rule nodes', async () => {
          const result = await queryRunner.manager.softDelete(Node, {
            ruleChainId: In(ruleChainIds),
            tenantId,
          });
          return result.affected ?? 0;
        });

        resourcesRemoved += await step('rule chains', async () => {
          const result = await queryRunner.manager.softDelete(RuleChain, {
            id: In(ruleChainIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
      }

      // ── ALARMS ────────────────────────────────────────────────────────────
      if (alarmIds.length) {
        resourcesRemoved += await step('alarms', async () => {
          const result = await queryRunner.manager.softDelete(Alarm, {
            id: In(alarmIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      // Only reached if the transaction machinery itself fails — the per-group
      // savepoints already absorb individual deletion errors.
      await queryRunner.rollbackTransaction();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Uninstall ${installationId} aborted before commit: ${message}`,
      );
      throw new InternalServerErrorException(
        `Uninstall failed: ${message}`,
      );
    } finally {
      await queryRunner.release();
    }

    // 3. Mark the installation ROLLED_BACK regardless of partial failures —
    //    the resources it owned are gone (or unrecoverable), so it must not be
    //    uninstallable a second time, and the template becomes installable again.
    installation.status = InstallationStatus.ROLLED_BACK;
    installation.completedAt = new Date();
    installation.error = failures.length
      ? `Uninstalled with errors: ${failures.join('; ')}`
      : undefined;
    await this.installationRepo.save(installation);

    // 4. Give the quota back. Uses the counts actually soft-deleted rather than
    //    the recorded id counts, so a partial teardown does not over-credit.
    if (devicesRemoved > 0) {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        'devices',
        devicesRemoved,
      );
    }
    if (dashboardsRemoved > 0) {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        'dashboards',
        dashboardsRemoved,
      );
    }

    const message = failures.length
      ? `Installation "${installation.installationName}" uninstalled with ${failures.length} error(s); ${resourcesRemoved} resource(s) removed`
      : `Installation "${installation.installationName}" uninstalled; ${resourcesRemoved} resource(s) removed`;

    this.logger.log(`Uninstall ${installationId}: ${message}`);

    return { success: failures.length === 0, message, resourcesRemoved };
  }

  // ── Installations ─────────────────────────────────────────────────────────

  async getInstallations(
    templateId: string,
    tenantId: string,
  ): Promise<TemplateInstallation[]> {
    // Ensures the template is visible to this tenant before listing
    await this.findOne(templateId, tenantId);

    return this.installationRepo.find({
      where: { templateId, tenantId },
      order: { installedAt: 'DESC' },
    });
  }

  /**
   * Every installation belonging to this tenant, across all templates.
   * The source template's identity is joined in so the caller does not need a
   * second round-trip per row.
   */
  async getMyInstallations(
    tenantId: string,
    page = 1,
    limit = 20,
  ): Promise<{
    data: TemplateInstallation[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;

    const [data, total] = await this.installationRepo
      .createQueryBuilder('installation')
      .leftJoin('installation.template', 'template')
      .addSelect([
        'template.id',
        'template.name',
        'template.category',
        'template.icon',
      ])
      .where('installation.tenantId = :tenantId', { tenantId })
      .orderBy('installation.installedAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Categories / statistics ───────────────────────────────────────────────

  async getCategories(
    tenantId: string,
  ): Promise<{ category: string; name: string; icon: string; count: number }[]> {
    const qb = this.templateRepository
      .createQueryBuilder('template')
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category');
    this.applyVisibility(qb, tenantId);

    const categoryCounts = await qb.getRawMany();

    const categoryMap = categoryCounts.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    const categories = [
      { category: TemplateCategory.SMART_FACTORY, name: 'Smart Factory', icon: 'factory' },
      { category: TemplateCategory.SMART_HOME, name: 'Smart Home', icon: 'home' },
      { category: TemplateCategory.SMART_BUILDING, name: 'Smart Building', icon: 'building' },
      { category: TemplateCategory.SMART_CITY, name: 'Smart City', icon: 'city' },
      { category: TemplateCategory.AGRICULTURE, name: 'Agriculture', icon: 'plant' },
      { category: TemplateCategory.HEALTHCARE, name: 'Healthcare', icon: 'hospital' },
      { category: TemplateCategory.ENERGY, name: 'Energy', icon: 'battery' },
      { category: TemplateCategory.LOGISTICS, name: 'Logistics', icon: 'truck' },
      { category: TemplateCategory.RETAIL, name: 'Retail', icon: 'shopping-cart' },
      { category: TemplateCategory.WATER, name: 'Water Management', icon: 'droplet' },
      { category: TemplateCategory.CLIMATE, name: 'Climate Control', icon: 'thermometer' },
      { category: TemplateCategory.EDUCATION, name: 'Education', icon: 'graduation-cap' },
    ];

    return categories.map((cat) => ({
      ...cat,
      count: categoryMap[cat.category] || 0,
    }));
  }

  async getStatistics(tenantId: string) {
    const base = () =>
      this.applyVisibility(
        this.templateRepository.createQueryBuilder('template'),
        tenantId,
      );

    const [total, premium, systemTemplates] = await Promise.all([
      base().getCount(),
      base().andWhere('template.isPremium = true').getCount(),
      base().andWhere('template.isSystem = true').getCount(),
    ]);

    const totalInstalls = await base()
      .select('SUM(template.installs)', 'total')
      .getRawOne();

    const byCategoryResult = await base()
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category')
      .getRawMany();

    const byCategory = byCategoryResult.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    const popular = await base()
      .orderBy('template.installs', 'DESC')
      .addOrderBy('template.rating', 'DESC')
      .take(5)
      .getMany();

    return {
      total,
      premium,
      free: total - premium,
      systemTemplates,
      userTemplates: total - systemTemplates,
      totalInstalls: parseInt(totalInstalls?.total || '0', 10),
      byCategory,
      popular: popular.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        installs: t.installs,
        rating: t.rating,
      })),
    };
  }

  // ── Rating ────────────────────────────────────────────────────────────────

  async rateTemplate(
    id: string,
    userId: string,
    tenantId: string,
    rating: number,
  ): Promise<SolutionTemplate> {
    if (typeof rating !== 'number' || Number.isNaN(rating)) {
      throw new BadRequestException('Rating must be a number');
    }
    if (rating < 0 || rating > 5) {
      throw new BadRequestException('Rating must be between 0 and 5');
    }

    const template = await this.findOne(id, tenantId);

    // One rating per user — re-rating replaces the previous value
    const ratings = { ...(template.ratings ?? {}) };
    ratings[userId] = rating;

    const values = Object.values(ratings);
    const average = values.reduce((sum, r) => sum + r, 0) / values.length;

    template.ratings = ratings;
    template.ratingCount = values.length;
    // decimal(3,2) — keep 2dp so the stored value round-trips exactly
    template.rating = Math.round(average * 100) / 100;
    template.updatedBy = userId;

    return await this.templateRepository.save(template);
  }
}
