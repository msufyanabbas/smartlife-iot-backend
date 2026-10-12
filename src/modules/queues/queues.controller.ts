import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  SwaggerAuth,
  TenantAdminOnly,
  TenantOrCustomerAdmin,
} from '@common/decorators/access-control.decorator';
import { QueuesService } from './queues.service';
import {
  AssignRuleChainDto,
  CreateQueueDto,
  QueueQueryDto,
  UpdateQueueDto,
} from './dto/queue.dto';

/**
 * Queue definitions — named processing lanes for the rule engine.
 *
 * Every handler carries an explicit roles decorator. `RolesGuard` returns TRUE
 * when a handler has no `@Roles` metadata, so an undecorated route here would
 * be open to every authenticated user, CUSTOMER_USER included. A queue is
 * tenant-wide processing configuration, so writes are TENANT_ADMIN (and
 * SUPER_ADMIN, which always passes); the read routes stay open to CUSTOMER so
 * a dashboard tile can show them.
 *
 * ── What is actually wired ─────────────────────────────────────────────────
 * A rule chain names a queue (`POST /queues/:id/rule-chains`). When a message
 * resolves to that chain, `RuleEngineConsumer` executes it through
 * `QueueExecutionService`, which honours the queue's `submitStrategy`
 * (BURST / SEQUENTIAL_BY_ORIGINATOR / SEQUENTIAL_BY_TENANT),
 * `packProcessingTimeout`, `processingStrategy` and retry settings.
 *
 * `topic`, `partitions`, `consumerPerPartition`, `pollInterval`,
 * `maxPollRecords`, `maxPollInterval`, `maxRequestSize`, `maxPendingMessages`
 * and `isDefault` are STORED AND NOT READ — they describe a Kafka topic and
 * consumer group, and this platform subscribes one group to one `rules.input`
 * topic at boot. `GET /queues/capabilities` returns both lists so the
 * configuration screen can label them instead of implying they take effect.
 */
@ApiTags('Queues')
@Controller('queues')
export class QueuesController {
  constructor(private readonly queuesService: QueuesService) {}

  @Get()
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'List queue definitions' })
  @SwaggerAuth('List queues', 'Paginated queues')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: QueueQueryDto,
  ) {
    return this.queuesService.findAll(tenantId, query);
  }

  // Both of these must precede `:id`, or the literal is parsed as a queue id.
  @Get('capabilities')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Which parts of a queue definition this platform honours',
    description:
      'Returns `honoured` and `storedOnly` field lists with the reason. Render ' +
      'the stored-only fields as such — tuning one of them changes nothing today.',
  })
  @SwaggerAuth('Queue capabilities', 'Honoured and stored-only fields')
  getCapabilities() {
    return this.queuesService.getCapabilities();
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Per-queue counts and observed usage',
    description:
      'Usage counters are buffered in memory and flushed every 10 seconds, so ' +
      'the newest few seconds of traffic may not be included and a restart ' +
      'loses at most one flush interval.',
  })
  @SwaggerAuth('Queue statistics', 'Counts per queue')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.queuesService.getStatistics(tenantId);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'One queue definition' })
  @SwaggerAuth('Get a queue', 'The queue')
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queuesService.findOne(tenantId, id);
  }

  @Get(':id/rule-chains')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Rule chains processed on this queue',
    description:
      'The chains whose `configuration.queueName` names this queue — i.e. the ' +
      'chains whose executions this queue’s settings actually govern.',
  })
  @SwaggerAuth('Rule chains on a queue', 'Assigned rule chains')
  listRuleChains(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queuesService.listRuleChains(tenantId, id);
  }

  @Post()
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Create a queue definition' })
  @SwaggerAuth('Create a queue', 'Queue created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateQueueDto,
  ) {
    return this.queuesService.create(tenantId, userId, dto);
  }

  @Post(':id/rule-chains')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Process a rule chain on this queue',
    description:
      'Writes `configuration.queueName` on the chain. From then on, messages ' +
      'routed to that chain run under this queue’s submit strategy, pack ' +
      'processing timeout, processing strategy and retries. Returns a `message` ' +
      'alongside the ids because the message states which chain moved where.',
  })
  @SwaggerAuth('Assign a rule chain to a queue', 'Rule chain assigned')
  assignRuleChain(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRuleChainDto,
  ) {
    return this.queuesService.assignRuleChain(tenantId, id, dto.ruleChainId);
  }

  @Put(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Update a queue definition',
    description:
      'Renaming a queue also repoints every rule chain that named it — chains ' +
      'reference a queue by name, so a bare rename would orphan them.',
  })
  @SwaggerAuth('Update a queue', 'Queue updated')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQueueDto,
  ) {
    return this.queuesService.update(tenantId, id, userId, dto);
  }

  // The shipped frontend client (`queues.api.ts`) sends PATCH. Same handler.
  @Patch(':id')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Update a queue definition (alias of PUT)' })
  @SwaggerAuth('Update a queue', 'Queue updated')
  patch(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQueueDto,
  ) {
    return this.queuesService.update(tenantId, id, userId, dto);
  }

  @Delete(':id/rule-chains/:ruleChainId')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Stop processing a rule chain on this queue' })
  @SwaggerAuth('Detach a rule chain', 'Rule chain detached')
  unassignRuleChain(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ruleChainId', ParseUUIDPipe) ruleChainId: string,
  ) {
    return this.queuesService.unassignRuleChain(tenantId, id, ruleChainId);
  }

  @Delete(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Delete a queue definition',
    description:
      'Refused with 400 while any rule chain still names it — a chain pointing ' +
      'at a deleted queue silently loses its timeout and retry behaviour. The ' +
      'errors array lists the chains to detach first.',
  })
  @SwaggerAuth('Delete a queue', 'Queue deleted')
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queuesService.remove(tenantId, id);
  }
}
