// src/common/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

// Key read by JwtAuthGuard to skip authentication on public routes
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * @Public()
 * Marks a route as publicly accessible — skips JWT authentication.
 * Apply to login, register, OAuth callbacks, health checks, etc.
 *
 * @example
 * @Public()
 * @Post('login')
 * login(@Body() dto: LoginDto) { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);