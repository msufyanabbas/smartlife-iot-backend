import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@modules/index.entities';
import { Request } from 'express';

/**
 * Augment Express Request type to include user property
 */
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * CurrentUser Decorator
 * Extracts the current authenticated user from the request
 * 
 * @param data - Optional property name to extract from user object
 * @returns The user object or a specific property
 * 
 * @example
 * // Get entire user object
 * @Get('profile')
 * getProfile(@CurrentUser() user: User) {
 *   return user;
 * }
 * 
 * @example
 * // Get specific user property
 * @Get('email')
 * getEmail(@CurrentUser('email') email: string) {
 *   return email;
 * }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext): User | unknown => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      return undefined;
    }

    // If a specific property is requested, return it
    // Otherwise return the entire user object
    return data ? user[data] : user;
  },
);