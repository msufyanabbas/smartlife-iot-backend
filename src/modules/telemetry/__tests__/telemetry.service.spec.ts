// src/modules/telemetry/__tests__/telemetry.service.spec.ts
// Complete test file for YOUR NestJS telemetry service

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelemetryService } from '../telemetry.service';
import { Telemetry } from '../entities/telemetry.entity';
import { Device } from '../../devices/entities/device.entity';
import { NotFoundException } from '@nestjs/common';
import { RedisService } from '@/lib/redis/redis.service';
import { TelemetryLatestCacheService } from '../telemetry-latest-cache.service';
import { ProfileAlarmService } from '@modules/profiles/profile-alarm.service';
import { IntegrationDispatchService } from '@modules/integrations/integration-dispatch.service';
import { AutomationService } from '@modules/automation/automation.service';
import { TelemetryRollupService } from '../telemetry-rollup.service';
import { TelemetryRetentionService } from '../telemetry-retention.service';

// NOTE: do NOT jest.mock('@lib/redis/redis.service') with a factory that only
// exports a `redisService` instance — TelemetryService injects the RedisService
// *class*, so replacing the module strips the class and Nest resolves the
// constructor's 3rd argument to `undefined` ("dependency at index [2]").
// Override it as a provider instead, which leaves the class token intact.
//
// TelemetryService does not inject KafkaService (see the note in the service),
// so no Kafka mock is needed.
//
// IntegrationDispatchService and AutomationService are both fire-and-forget
// side effects of create()/createBatch(); they are stubbed so the HTTP
// ingestion path can be asserted without an outbound HTTP call or an
// automation run.

describe('TelemetryService', () => {
  let service: TelemetryService;
  let telemetryRepository: Repository<Telemetry>;
  let deviceRepository: Repository<Device>;

  // Mock repositories
  const mockTelemetryRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockDeviceRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
  };

  // RedisService is still injected by TelemetryService, but the latest-reading
  // cache now belongs to TelemetryLatestCacheService (see that class — it has
  // to be shared with TelemetryConsumer, the other writer).
  const mockRedisService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
  };

  // `read` returns null so every test stays on the database path, which is
  // what they assert. A mock that returned a row would make getLatest() tests
  // pass without touching the repository at all.
  const mockLatestCacheService = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
    getTtlSeconds: jest.fn().mockReturnValue(300),
  };

  // The HTTP ingestion path evaluates device-profile alarm rules directly
  // (it bypasses Kafka, so TelemetryConsumer never sees these readings).
  const mockProfileAlarmService = {
    evaluateProfileAlarmRules: jest.fn().mockResolvedValue(undefined),
  };

  const mockIntegrationDispatchService = {
    dispatchTelemetry: jest.fn().mockResolvedValue(undefined),
  };

  const mockAutomationService = {
    evaluateTelemetryTriggers: jest.fn().mockResolvedValue(undefined),
  };

  // The rollup/retention services are what the statistics, aggregated and
  // timeseries reads consult before falling back to a raw scan, and what
  // deleteOldData() now delegates to. `shouldUseRollups: false` keeps every
  // test in this file on the raw path, which is what they assert.
  const mockRollupService = {
    settings: { rollupEnabled: true },
    shouldUseRollups: jest.fn().mockReturnValue(false),
    pickGranularity: jest.fn().mockReturnValue('hour'),
    readSeries: jest.fn().mockResolvedValue([]),
    readAllKeys: jest.fn().mockResolvedValue([]),
    readStatistics: jest.fn().mockResolvedValue({ buckets: 0, keys: {} }),
    coverage: jest.fn().mockResolvedValue([]),
  };

  const mockRetentionService = {
    settings: { retentionEnabled: true },
    sweepTenant: jest
      .fn()
      .mockResolvedValue({ deleted: 0, batches: 0, moreRemaining: false }),
    preview: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    // Create testing module
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryService,
        {
          provide: getRepositoryToken(Telemetry),
          useValue: mockTelemetryRepository,
        },
        {
          provide: getRepositoryToken(Device),
          useValue: mockDeviceRepository,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: TelemetryLatestCacheService,
          useValue: mockLatestCacheService,
        },
        {
          provide: ProfileAlarmService,
          useValue: mockProfileAlarmService,
        },
        {
          provide: IntegrationDispatchService,
          useValue: mockIntegrationDispatchService,
        },
        {
          provide: AutomationService,
          useValue: mockAutomationService,
        },
        {
          provide: TelemetryRollupService,
          useValue: mockRollupService,
        },
        {
          provide: TelemetryRetentionService,
          useValue: mockRetentionService,
        },
      ],
    }).compile();

    service = module.get<TelemetryService>(TelemetryService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create telemetry successfully', async () => {
      const deviceKey = 'test-key';
      const createDto = { temperature: 23.5 };
      const mockDevice = {
        id: 'dev-123',
        deviceKey: 'test-key',
        tenantId: 'ten-123',
      };
      const mockTelemetry = { id: 'tel-123', ...createDto };

      mockDeviceRepository.findOne.mockResolvedValue(mockDevice);
      mockTelemetryRepository.create.mockReturnValue(mockTelemetry);
      mockTelemetryRepository.save.mockResolvedValue(mockTelemetry);
      mockDeviceRepository.update.mockResolvedValue({ affected: 1 });

      const result = await service.create(deviceKey, createDto as any);

      expect(result).toEqual(mockTelemetry);
      expect(mockTelemetryRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if device not found', async () => {
      mockDeviceRepository.findOne.mockResolvedValue(null);

      await expect(service.create('wrong-key', {} as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
