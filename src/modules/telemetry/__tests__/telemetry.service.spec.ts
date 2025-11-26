// src/modules/telemetry/__tests__/telemetry.service.spec.ts
// Complete test file for YOUR NestJS telemetry service

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelemetryService } from '../telemetry.service';
import { Telemetry } from '../entities/telemetry.entity';
import { Device } from '../../devices/entities/device.entity';
import { NotFoundException } from '@nestjs/common';

// Mock Kafka and Redis
jest.mock('@lib/kafka/kafka.service', () => ({
  kafkaService: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendBatch: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@lib/redis/redis.service', () => ({
  redisService: {
    hmset: jest.fn().mockResolvedValue(undefined),
    lpush: jest.fn().mockResolvedValue(undefined),
    ltrim: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    hset: jest.fn().mockResolvedValue(undefined),
    hgetall: jest.fn().mockResolvedValue({}),
  },
}));

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
