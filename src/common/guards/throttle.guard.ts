import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request } from 'express';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    // Use user ID if authenticated, otherwise use IP
    const user = (req as any).user;
    if (user && user.id) {
      return `user-${user.id}`;
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  protected async getErrorMessage(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<string> {
    return 'Too many requests. Please try again later.';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      // Log rate limit violations
      const request = context.switchToHttp().getRequest<Request>();
      console.warn(
        `Rate limit exceeded for ${await this.getTracker(request)} on ${request.method} ${request.url}`,
      );
      throw error;
    }
  }
}
