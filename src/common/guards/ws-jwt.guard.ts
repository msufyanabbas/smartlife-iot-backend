import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * WebSocket JWT Authentication Guard
 * Validates JWT tokens for WebSocket connections
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const client: Socket = context.switchToWs().getClient();

      // Extract token from different sources
      const token = this.extractToken(client);

      if (!token) {
        this.logger.warn('No token provided in WebSocket connection');
        throw new WsException('Unauthorized - No token provided');
      }

      // Verify token
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });

      // Attach user info to client for use in handlers
      client.handshake.auth = {
        ...client.handshake.auth,
        userId: payload.sub,
        email: payload.email,
        user: payload,
      };

      // Store in client data as well
      client.data.userId = payload.sub;
      client.data.email = payload.email;

      this.logger.debug(`WebSocket authenticated for user: ${payload.email}`);

      return true;
    } catch (error) {
      this.logger.error(`WebSocket authentication failed: ${error.message}`);
      throw new WsException('Unauthorized - Invalid token');
    }
  }

  /**
   * Extract JWT token from various sources
   */
  private extractToken(client: Socket): string | null {
    // 1. Try from handshake auth (recommended)
    if (client.handshake.auth?.token) {
      return client.handshake.auth.token;
    }

    // 2. Try from handshake headers (Authorization header)
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    // 3. Try from query parameters (fallback for some clients)
    if (client.handshake.query?.token) {
      return client.handshake.query.token as string;
    }

    return null;
  }
}
