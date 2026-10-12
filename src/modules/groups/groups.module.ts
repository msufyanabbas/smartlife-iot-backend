import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { Customer } from '@modules/customers/entities/customers.entity';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Repositories only, so this module can never take part in a cycle.
 *
 * Device, Asset and User are NOT registered: member validation reads them
 * through one parameterised query built from `GROUP_MEMBER_SOURCES` (a table
 * name per entity type), which is what lets a new groupable entity kind be one
 * row in that map instead of another repository, another import and another
 * branch. `Customer` is registered because `customerId` scoping on the group
 * itself is a normal relation check, not a polymorphic one.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Group, GroupMember, Customer])],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
