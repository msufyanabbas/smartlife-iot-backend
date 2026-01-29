import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomerStatus } from '@/common/enums/index.enum';
import { Customer } from '@modules/index.entities';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  BulkUpdateCustomerStatusDto,
} from './dto/customers.dto';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new customer
   */
  async create(createCustomerDto: CreateCustomerDto): Promise<Customer> {
    // Check if customer with same title exists in this tenant
    const existingCustomer = await this.customerRepository.findOne({
      where: {
        name: createCustomerDto.name,
        tenantId: createCustomerDto.tenantId,
      },
    });

    if (existingCustomer) {
      throw new ConflictException(
        'Customer with this title already exists in this tenant',
      );
    }

    const customer = this.customerRepository.create(createCustomerDto);
    const savedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.created', { customer: savedCustomer });

    return savedCustomer;
  }

  /**
   * Find all customers with pagination and filters
   */
  async findAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    status?: CustomerStatus;
    tenantId?: string;
    isPublic?: boolean;
  }): Promise<{
    customers: Customer[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.customerRepository.createQueryBuilder('customer');

    // Apply filters
    if (options.search) {
      queryBuilder.andWhere(
        '(customer.title ILIKE :search OR customer.email ILIKE :search OR customer.city ILIKE :search)',
        { search: `%${options.search}%` },
      );
    }

    if (options.status) {
      queryBuilder.andWhere('customer.status = :status', {
        status: options.status,
      });
    }

    if (options.tenantId) {
      queryBuilder.andWhere('customer.tenantId = :tenantId', {
        tenantId: options.tenantId,
      });
    }

    if (options.isPublic !== undefined) {
      queryBuilder.andWhere('customer.isPublic = :isPublic', {
        isPublic: options.isPublic,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const customers = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('customer.createdAt', 'DESC')
      .getMany();

    return {
      customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find one customer by ID
   */
  async findOne(id: string): Promise<Customer> {
    const customer = await this.customerRepository.findOne({ where: { id } });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return customer;
  }

  /**
   * Find customer by title and tenant
   */
  async findByTitleAndTenant(
    name: string,
    tenantId: string,
  ): Promise<Customer | null> {
    return await this.customerRepository.findOne({
      where: { name, tenantId },
    });
  }

  /**
   * Update customer
   */
  async update(
    id: string,
    updateCustomerDto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOne(id);

    // Check if title is being changed and if it's already taken
    if (updateCustomerDto.name && updateCustomerDto.name !== customer.name) {
      const existingCustomer = await this.findByTitleAndTenant(
        updateCustomerDto.name,
        customer.tenantId,
      );
      if (existingCustomer) {
        throw new ConflictException('Customer title already in use');
      }
    }

    Object.assign(customer, updateCustomerDto);

    const updatedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.updated', { customer: updatedCustomer });

    return updatedCustomer;
  }

  /**
   * Delete customer (soft delete)
   */
  async remove(id: string): Promise<void> {
    const customer = await this.findOne(id);

    await this.customerRepository.softRemove(customer);

    // Emit event
    this.eventEmitter.emit('customer.deleted', { customerId: id });
  }

  /**
   * Update customer status
   */
  async updateStatus(
    customerId: string,
    status: CustomerStatus,
  ): Promise<Customer> {
    const customer = await this.findOne(customerId);
    const previousStatus = customer.status;
    customer.status = status;

    const updatedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.status.changed', {
      customerId,
      status,
      previousStatus,
    });

    return updatedCustomer;
  }

  /**
   * Bulk update customer status
   */
  async bulkUpdateStatus(
    bulkUpdateDto: BulkUpdateCustomerStatusDto,
  ): Promise<void> {
    await this.customerRepository.update(
      { id: In(bulkUpdateDto.customerIds) },
      { status: bulkUpdateDto.status },
    );

    // Emit event
    this.eventEmitter.emit('customers.status.bulk.updated', {
      customerIds: bulkUpdateDto.customerIds,
      status: bulkUpdateDto.status,
    });
  }

  /**
   * Get customers by tenant
   */
  async findByTenant(tenantId: string): Promise<Customer[]> {
    return await this.customerRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Search customers by term
   */
  async search(
    term: string,
    tenantId?: string,
    limit: number = 10,
  ): Promise<Customer[]> {
    const queryBuilder = this.customerRepository.createQueryBuilder('customer');

    queryBuilder.where(
      '(customer.title ILIKE :term OR customer.email ILIKE :term OR customer.city ILIKE :term)',
      { term: `%${term}%` },
    );

    if (tenantId) {
      queryBuilder.andWhere('customer.tenantId = :tenantId', { tenantId });
    }

    return await queryBuilder.take(limit).getMany();
  }

  /**
   * Get customer statistics
   */
  async getStatistics(tenantId?: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    suspended: number;
    public: number;
    private: number;
  }> {
    const queryBuilder = this.customerRepository.createQueryBuilder('customer');

    if (tenantId) {
      queryBuilder.where('customer.tenantId = :tenantId', { tenantId });
    }

    const [total, active, inactive, suspended, publicCustomers, privateCustomers] =
      await Promise.all([
        queryBuilder.getCount(),
        queryBuilder
          .clone()
          .andWhere('customer.status = :status', {
            status: CustomerStatus.ACTIVE,
          })
          .getCount(),
        queryBuilder
          .clone()
          .andWhere('customer.status = :status', {
            status: CustomerStatus.INACTIVE,
          })
          .getCount(),
        queryBuilder
          .clone()
          .andWhere('customer.status = :status', {
            status: CustomerStatus.SUSPENDED,
          })
          .getCount(),
        queryBuilder
          .clone()
          .andWhere('customer.isPublic = :isPublic', { isPublic: true })
          .getCount(),
        queryBuilder
          .clone()
          .andWhere('customer.isPublic = :isPublic', { isPublic: false })
          .getCount(),
      ]);

    return {
      total,
      active,
      inactive,
      suspended,
      public: publicCustomers,
      private: privateCustomers,
    };
  }

  /**
   * Get public customers (accessible to all tenant users)
   */
  async getPublicCustomers(tenantId: string): Promise<Customer[]> {
    return await this.customerRepository.find({
      where: {
        tenantId,
        isPublic: true,
        status: CustomerStatus.ACTIVE,
      },
      order: { name: 'ASC' },
    });
  }

  /**
   * Check if customer exists
   */
  async exists(id: string): Promise<boolean> {
    const count = await this.customerRepository.count({ where: { id } });
    return count > 0;
  }

  /**
   * Get customers by status
   */
  async findByStatus(
    status: CustomerStatus,
    tenantId?: string,
  ): Promise<Customer[]> {
    const where: any = { status };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return await this.customerRepository.find({
      where,
      order: { name: 'ASC' },
    });
  }
}