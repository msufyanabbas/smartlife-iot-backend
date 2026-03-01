// src/modules/assignments/assignment.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import {
  CustomerDevice,
  CustomerDashboard,
  CustomerAsset,
  CustomerFloorPlan,
  CustomerAutomation,
  UserDevice,
  UserDashboard,
  UserAsset,
  UserFloorPlan,
  UserAutomation,
} from './entities/resource-assignment.entities';
import {
  Customer,
  CustomerUserLimit,
  Subscription,
  User,
} from '@modules/index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Customer-level assignments
      CustomerDevice,
      CustomerDashboard,
      CustomerAsset,
      CustomerFloorPlan,
      CustomerAutomation,
      
      // User-level assignments
      UserDevice,
      UserDashboard,
      UserAsset,
      UserFloorPlan,
      UserAutomation,
      
      // Dependencies
      Customer,
      CustomerUserLimit,
      Subscription,
      User,
    ]),
  ],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}