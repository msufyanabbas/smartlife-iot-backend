import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import {
  RuleChainTemplate,
  RuleChainTemplateDefinition,
} from './entities/rule-chain-template.entity';
import {
  BUILT_IN_RULE_CHAIN_TEMPLATES,
  BUILT_IN_TEMPLATE_CATEGORIES,
  validateTemplateDefinition,
  type TemplateIssue,
} from './rule-chain-template-catalogue';
import {
  CreateRuleChainTemplateDto,
  UpdateRuleChainTemplateDto,
  InstantiateRuleChainTemplateDto,
  RuleChainTemplateQueryDto,
} from './dto/rule-chain-template.dto';
import { RulesService } from './rules.service';

/**
 * Rule chain templates: reusable definitions a tenant stamps out into real
 * chains.
 *
 * The definition format is deliberately the one `RulesService.exportChain()`
 * emits, so three things that would otherwise each need their own code path
 * are the same path: saving a chain as a template, instantiating a template,
 * and importing an exported chain. `instantiate()` is a thin wrapper over
 * `importChain()`.
 */
@Injectable()
export class RuleChainTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(RuleChainTemplatesService.name);

  constructor(
    @InjectRepository(RuleChainTemplate)
    private readonly templateRepo: Repository<RuleChainTemplate>,
    private readonly rulesService: RulesService,
  ) {}

  async onModuleInit() {
    await this.syncBuiltIns();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUILT-INS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Upsert the code-defined templates, matched on `slug`.
   *
   * Runs at boot so a deploy can correct a definition, and so a fresh database
   * has starting points without a seed step. Non-fatal by design: the platform
   * must still boot against a database where the table does not exist yet (the
   * migration is applied separately — see CLAUDE.md §11), and starter content
   * is not worth taking the application down for.
   */
  async syncBuiltIns(): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    try {
      for (const builtIn of BUILT_IN_RULE_CHAIN_TEMPLATES) {
        const existing = await this.templateRepo.findOne({
          where: { slug: builtIn.slug },
        });

        if (existing) {
          // A built-in is platform content: its definition is replaced from
          // code. usageCount and lastUsedAt are tenant history and are left
          // alone.
          existing.name = builtIn.name;
          existing.description = builtIn.description;
          existing.category = builtIn.category;
          existing.icon = builtIn.icon;
          existing.definition = builtIn.definition;
          existing.isBuiltIn = true;
          existing.tenantId = null;
          await this.templateRepo.save(existing);
          updated++;
        } else {
          await this.templateRepo.save(
            this.templateRepo.create({
              slug: builtIn.slug,
              name: builtIn.name,
              description: builtIn.description,
              category: builtIn.category,
              icon: builtIn.icon,
              definition: builtIn.definition,
              isBuiltIn: true,
              tenantId: null,
              userId: null,
            }),
          );
          created++;
        }
      }

      if (created || updated) {
        this.logger.log(
          `Built-in rule chain templates synced (${created} created, ${updated} updated)`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not sync built-in rule chain templates: ${error?.message}. ` +
          'Has the RuleChainTemplates migration been applied?',
      );
    }

    return { created, updated };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string, query: RuleChainTemplateQueryDto) {
    const { page = 1, limit = 20, search, category, scope } = query;
    const skip = (page - 1) * limit;

    const qb = this.templateRepo.createQueryBuilder('t');

    // A tenant sees its own templates plus every platform one. Built-ins have
    // a NULL tenantId, which no equality test would ever match — hence the
    // explicit IS NULL rather than relying on the usual tenant filter.
    if (scope === 'mine') {
      qb.where('t.tenantId = :tenantId', { tenantId });
    } else if (scope === 'builtin') {
      qb.where('t.isBuiltIn = true');
    } else {
      qb.where(
        new Brackets((w) =>
          w
            .where('t.tenantId = :tenantId', { tenantId })
            .orWhere('t.isBuiltIn = true'),
        ),
      );
    }

    if (search) {
      qb.andWhere('(t.name ILIKE :search OR t.description ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (category) {
      qb.andWhere('t.category = :category', { category });
    }

    const sortable: Record<string, string> = {
      name: 't.name',
      category: 't.category',
      usageCount: 't.usageCount',
      createdAt: 't.createdAt',
      updatedAt: 't.updatedAt',
    };
    const sortColumn = sortable[query.sortBy ?? ''] ?? 't.name';
    const sortOrder = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';

    // Built-ins last when sorting by name so a tenant's own work is on top;
    // by usage, popularity decides outright.
    qb.orderBy(sortColumn, sortColumn === 't.name' ? 'ASC' : sortOrder)
      .skip(skip)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();

    return PaginatedResponseDto.create(
      rows.map((row) => this.summarise(row)),
      page,
      limit,
      total,
    );
  }

  async getCategories(tenantId: string): Promise<string[]> {
    const rows = await this.templateRepo
      .createQueryBuilder('t')
      .select('DISTINCT t.category', 'category')
      .where(
        new Brackets((w) =>
          w
            .where('t.tenantId = :tenantId', { tenantId })
            .orWhere('t.isBuiltIn = true'),
        ),
        { tenantId },
      )
      .getRawMany<{ category: string }>();

    return Array.from(
      new Set([
        ...BUILT_IN_TEMPLATE_CATEGORIES,
        ...rows.map((r) => r.category).filter(Boolean),
      ]),
    ).sort();
  }

  /** The row itself, scoped. Built-ins are readable by every tenant. */
  async findEntity(tenantId: string, id: string): Promise<RuleChainTemplate> {
    const template = await this.templateRepo.findOne({ where: { id } });

    if (
      !template ||
      (!template.isBuiltIn && template.tenantId !== tenantId) ||
      (template.isBuiltIn && template.tenantId !== null)
    ) {
      throw new NotFoundException('Rule chain template not found');
    }

    return template;
  }

  /**
   * One template with its full definition, plus the same static analysis the
   * chain editor shows — so a user can see a template is wired correctly, or
   * what it will complain about, before creating anything from it.
   */
  async findOne(tenantId: string, id: string) {
    const template = await this.findEntity(tenantId, id);
    return {
      ...this.summarise(template),
      definition: template.definition,
      issues: this.validateDefinition(template.definition),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITE
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateRuleChainTemplateDto,
  ) {
    const definition = await this.resolveDefinition(tenantId, dto);

    const issues = this.validateDefinition(definition);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new BadRequestException({
        message: 'The template definition is not valid',
        errors: errors.map((e) => e.message),
      });
    }

    const name = await this.uniqueName(tenantId, dto.name);

    const saved = await this.templateRepo.save(
      this.templateRepo.create({
        tenantId,
        userId,
        name,
        description: dto.description,
        category: dto.category?.trim() || 'General',
        icon: dto.icon ?? null,
        slug: null,
        isBuiltIn: false,
        definition,
      }),
    );

    this.logger.log(`Rule chain template created: ${saved.id} (${name})`);
    return this.findOne(tenantId, saved.id);
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateRuleChainTemplateDto,
  ) {
    const template = await this.assertEditable(tenantId, id);

    if (dto.definition || dto.fromRuleChainId) {
      const definition = await this.resolveDefinition(tenantId, dto);
      const errors = this.validateDefinition(definition).filter(
        (i) => i.severity === 'error',
      );
      if (errors.length) {
        throw new BadRequestException({
          message: 'The template definition is not valid',
          errors: errors.map((e) => e.message),
        });
      }
      template.definition = definition;
    }

    if (dto.name !== undefined && dto.name !== template.name) {
      template.name = await this.uniqueName(tenantId, dto.name, id);
    }
    if (dto.description !== undefined) template.description = dto.description;
    if (dto.category !== undefined) {
      template.category = dto.category.trim() || 'General';
    }
    if (dto.icon !== undefined) template.icon = dto.icon ?? null;

    await this.templateRepo.save(template);
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string) {
    const template = await this.assertEditable(tenantId, id);
    await this.templateRepo.softRemove(template);
    return { message: 'Rule chain template deleted', id };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INSTANTIATE — what the "Use" button does
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a real rule chain from a template.
   *
   * Goes through `RulesService.importChain()`, which already handles name
   * de-duplication, index→id edge rewriting and the atomic whole-graph write.
   * The new chain lands **disabled** unless asked otherwise: a template can
   * carry a placeholder endpoint or an id from whoever authored it, so going
   * live is a decision, not a side effect of clicking Use.
   */
  async instantiate(
    tenantId: string,
    userId: string,
    id: string,
    dto: InstantiateRuleChainTemplateDto = {},
  ) {
    const template = await this.findEntity(tenantId, id);

    // importChain returns the saved graph as `{ ruleChain, nodes, ... }`.
    // Flattened below rather than nested as `ruleChain.ruleChain`, which is
    // the kind of envelope the client then has to guess at.
    const metadata = await this.rulesService.importChain(
      tenantId,
      userId,
      {
        ...template.definition,
        name: dto.name?.trim() || template.name,
        description: template.definition?.description ?? template.description,
      },
      { enabled: dto.enabled === true },
    );

    // Usage is counted on the template row itself, including on a built-in —
    // which is why built-ins are DB rows rather than served straight from the
    // catalogue. A failed increment must not lose the chain the user just
    // created, so it is best-effort.
    try {
      await this.templateRepo.increment({ id: template.id }, 'usageCount', 1);
      await this.templateRepo.update(
        { id: template.id },
        { lastUsedAt: new Date() },
      );
    } catch (error: any) {
      this.logger.warn(
        `Could not record usage for template ${template.id}: ${error?.message}`,
      );
    }

    this.logger.log(
      `Rule chain created from template ${template.id} (${template.name})`,
    );

    return {
      message: 'Rule chain created from template',
      ruleChain: metadata.ruleChain,
      nodes: metadata.nodes,
      issues: metadata.issues,
      template: { id: template.id, name: template.name },
      // The things the template could not guess — an endpoint, a recipient.
      // Returned here so the editor can show them the moment the chain opens,
      // which is the difference between a starting point and a chain that
      // looks finished and does nothing.
      setupNotes: (template.definition as any)?.setupNotes ?? [],
    };
  }

  /** Download a template as JSON — the same format `POST /rule-chains/import` takes. */
  async exportTemplate(tenantId: string, id: string) {
    const template = await this.findEntity(tenantId, id);
    return {
      ...template.definition,
      name: template.name,
      description: template.description ?? template.definition?.description,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ══════════════════════════════════════════════════════════════════════════

  private summarise(template: RuleChainTemplate) {
    const nodes = Array.isArray(template.definition?.nodes)
      ? template.definition.nodes
      : [];

    return {
      id: template.id,
      slug: template.slug,
      name: template.name,
      description: template.description,
      category: template.category,
      icon: template.icon,
      isBuiltIn: template.isBuiltIn,
      // A built-in cannot be edited or deleted by a tenant. Returned as a flag
      // rather than left to the client to infer from isBuiltIn, so the buttons
      // and the server agree on one rule.
      editable: !template.isBuiltIn,
      usageCount: template.usageCount,
      lastUsedAt: template.lastUsedAt ?? null,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      nodeCount: nodes.length,
      // Enough for a card to show the shape of the chain without fetching the
      // whole definition for every tile in the grid.
      nodeTypes: Array.from(new Set(nodes.map((n) => n.type))),
      nodeNames: nodes.slice(0, 6).map((n) => n.name),
      setupNotes: (template.definition as any)?.setupNotes ?? [],
    };
  }

  /** Either the supplied definition, or one captured from an existing chain. */
  private async resolveDefinition(
    tenantId: string,
    dto: CreateRuleChainTemplateDto | UpdateRuleChainTemplateDto,
  ): Promise<RuleChainTemplateDefinition> {
    if (dto.definition && dto.fromRuleChainId) {
      throw new BadRequestException(
        'Supply either "definition" or "fromRuleChainId", not both',
      );
    }

    if (dto.fromRuleChainId) {
      // exportChain is tenant-scoped and 404s on a chain this tenant does not
      // own, so a crafted id cannot capture another tenant's graph.
      const exported = await this.rulesService.exportChain(
        tenantId,
        dto.fromRuleChainId,
      );
      return exported as RuleChainTemplateDefinition;
    }

    if (dto.definition) {
      return dto.definition as RuleChainTemplateDefinition;
    }

    throw new BadRequestException(
      'A template needs either a "definition" or a "fromRuleChainId" to capture',
    );
  }

  private async assertEditable(tenantId: string, id: string) {
    const template = await this.findEntity(tenantId, id);

    if (template.isBuiltIn) {
      throw new ForbiddenException(
        'Built-in templates are read-only. Use it to create a chain, change that chain, then save it as your own template.',
      );
    }

    return template;
  }

  private async uniqueName(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<string> {
    const base = String(name ?? '').trim().slice(0, 200) || 'Template';
    let candidate = base;

    for (let attempt = 1; attempt <= 50; attempt++) {
      const clash = await this.templateRepo.findOne({
        where: { tenantId, name: candidate },
      });
      if (!clash || clash.id === excludeId) return candidate;
      candidate = `${base} (${attempt})`;
    }

    return `${base} (${Date.now()})`;
  }

  /**
   * Static analysis of a definition — the same issue list the chain editor
   * shows, computed against node indexes. Delegates to the pure function in
   * the catalogue so `npm run check:rule-templates` can assert it over the
   * built-ins with no container and no database.
   */
  validateDefinition(
    definition: RuleChainTemplateDefinition | null | undefined,
  ): TemplateIssue[] {
    return validateTemplateDefinition(definition);
  }
}
