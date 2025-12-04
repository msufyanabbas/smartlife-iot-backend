import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SharingService } from './sharing.service';
import { CreateShareDto } from './dto/create-sharing.dto';
import { UpdateShareDto } from './dto/update-sharing.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { TrackUsage, UsageTrackingInterceptor } from '@/common/interceptors/usage-tracking.interceptor';

@ApiTags('sharing')
@Controller('sharing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SharingController {
  constructor(private readonly sharingService: SharingService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new share' })
  @UseInterceptors(UsageTrackingInterceptor)
  @TrackUsage({ resource: 'users', incrementBy: 1 })
  @ApiResponse({ status: 201, description: 'Share created successfully' })
  create(@CurrentUser() user: User, @Body() createShareDto: CreateShareDto) {
    return this.sharingService.create(user.id, createShareDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all shares created by user' })
  @ApiResponse({ status: 200, description: 'List of shares' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.sharingService.findAll(user.id, paginationDto);
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Get shares shared with current user' })
  @ApiResponse({ status: 200, description: 'List of shares' })
  getSharedWithMe(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.sharingService.getSharedWithMe(
      user.id,
      user.email,
      paginationDto,
    );
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get sharing statistics' })
  @ApiResponse({ status: 200, description: 'Sharing statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.sharingService.getStatistics(user.id);
  }

  @Get('link/:token')
  @ApiOperation({ summary: 'Access shared resource via token' })
  @ApiResponse({ status: 200, description: 'Shared resource details' })
  @ApiResponse({ status: 404, description: 'Share not found' })
  @ApiResponse({ status: 403, description: 'Share expired' })
  accessByToken(@Param('token') token: string) {
    return this.sharingService.findByToken(token);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get share by ID' })
  @ApiResponse({ status: 200, description: 'Share details' })
  @ApiResponse({ status: 404, description: 'Share not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.sharingService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update share' })
  @ApiResponse({ status: 200, description: 'Share updated successfully' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateShareDto: UpdateShareDto,
  ) {
    return this.sharingService.update(id, user.id, updateShareDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke share' })
  @ApiResponse({ status: 204, description: 'Share revoked successfully' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.sharingService.remove(id, user.id);
  }

  @Post(':token/track-view')
  @ApiOperation({ summary: 'Track view on shared resource' })
  @ApiResponse({ status: 200, description: 'View tracked' })
  trackView(@Param('token') token: string) {
    return this.sharingService.trackView(token);
  }

  @Delete('resource/:resourceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke all shares for a resource' })
  @ApiResponse({ status: 200, description: 'Shares revoked' })
  revokeByResource(
    @CurrentUser() user: User,
    @Param('resourceId') resourceId: string,
  ) {
    return this.sharingService.revokeByResourceId(user.id, resourceId);
  }
}
