// src/common/guards/ws-jwt.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const client: Socket = context.switchToWs().getClient();
      const token = this.extractToken(client);

      if (!token) {
        throw new WsException('Unauthorized: no token provided');
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });

      // Store the same fields that HTTP guards read from req.user
      // so WebSocket handlers can use the same guards/decorators
      client.data.userId    = payload.sub;
      client.data.email     = payload.email;
      client.data.role      = payload.role;
      client.data.tenantId  = payload.tenantId  ?? null;  // ← added
      client.data.customerId = payload.customerId ?? null; // ← added

      // Also attach a user-shaped object so @CurrentUser() decorator works
      // in WebSocket message handlers the same way it does in HTTP controllers
      client.data.user = {
        id:         payload.sub,
        email:      payload.email,
        role:       payload.role,
        tenantId:   payload.tenantId  ?? null,
        customerId: payload.customerId ?? null,
      };

      this.logger.debug(`WebSocket authenticated: ${payload.email} (tenant: ${payload.tenantId})`);
      return true;

    } catch (error) {
      this.logger.error(`WebSocket auth failed: ${error.message}`);
      throw new WsException('Unauthorized: invalid or expired token');
    }
  }

  private extractToken(client: Socket): string | null {
    // 1. Handshake auth object (recommended — most secure)
    if (client.handshake.auth?.token) {
      return client.handshake.auth.token;
    }

    // 2. Authorization header
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) return token;
    }

    // 3. Query param fallback (least secure — only for clients that can't set headers)
    if (client.handshake.query?.token) {
      return client.handshake.query.token as string;
    }

    return null;
  }
}