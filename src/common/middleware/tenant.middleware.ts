import {
  Injectable,
  NestMiddleware,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

export interface TenantRequest extends Request {
  tenantId?: string;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: TenantRequest, res: Response, next: NextFunction): void {
    // Extract tenant ID from header
    const tenantId = req.headers['x-tenant-id'] as string;

    // For authenticated users, tenant might come from JWT
    const user = (req as any).user;

    if (tenantId) {
      // Validate tenant ID format (UUID)
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(tenantId)) {
        throw new BadRequestException('Invalid tenant ID format');
      }
      req.tenantId = tenantId;
    } else if (user && user.tenantId) {
      // Use tenant from authenticated user
      req.tenantId = user.tenantId;
    }

    // Continue without tenant ID if not required
    // Individual routes can enforce tenant requirement
    next();
  }
}
