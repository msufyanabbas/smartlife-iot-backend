import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { redisService } from '@/lib/redis/redis.service';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject('REDIS_SERVICE') private readonly redis: typeof redisService,
  ) {}

  /**
   * Create a new session for user (overwrites any existing session)
   * This ensures only ONE active session per user
   */
  async createSession(
    userId: string,
    sessionId: string,
    metadata?: {
      ipAddress?: string;
      userAgent?: string;
      loginMethod?: 'local' | 'google' | 'github' | 'apple';
    },
  ): Promise<void> {
    const sessionKey = `user:${userId}:session`;

    // Store session data
    const sessionData = {
      sessionId,
      userId,
      createdAt: new Date().toISOString(),
      refreshTokens: [], // 🆕 Track associated refresh tokens
      ...metadata,
    };

    // Set with 7 days expiry (matching refresh token expiry)
    await this.redis.set(
      sessionKey,
      JSON.stringify(sessionData),
      60 * 60 * 24 * 7, // 7 days in seconds
    );

    // Also store reverse mapping for quick lookup
    await this.redis.set(
      `session:${sessionId}`,
      userId,
      60 * 60 * 24 * 7, // 7 days in seconds
    );

    this.logger.log(
      `Session created for user ${userId} via ${metadata?.loginMethod || 'unknown'}`,
    );
  }

  /**
   * 🆕 Add a refresh token to the current session
   */
  async addRefreshTokenToSession(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<void> {
    const sessionKey = `user:${userId}:session`;
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      this.logger.warn(`Cannot add refresh token: No session found for user ${userId}`);
      return;
    }

    try {
      const session = JSON.parse(sessionData);
      
      // Verify this is the correct session
      if (session.sessionId !== sessionId) {
        this.logger.warn(
          `Session mismatch for user ${userId}: expected ${session.sessionId}, got ${sessionId}`,
        );
        return;
      }

      // Add refresh token to the list (keep last 5)
      if (!session.refreshTokens) {
        session.refreshTokens = [];
      }
      
      session.refreshTokens.push(refreshToken);
      
      // Keep only last 5 refresh tokens
      if (session.refreshTokens.length > 5) {
        session.refreshTokens = session.refreshTokens.slice(-5);
      }

      // Update session
      await this.redis.set(
        sessionKey,
        JSON.stringify(session),
        60 * 60 * 24 * 7,
      );
    } catch (error) {
      this.logger.error(`Error adding refresh token to session for user ${userId}:`, error);
    }
  }

  /**
   * 🆕 Check if a refresh token belongs to the current session
   */
  async isRefreshTokenValidForSession(
    userId: string,
    refreshToken: string,
  ): Promise<boolean> {
    const sessionKey = `user:${userId}:session`;
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      return false;
    }

    try {
      const session = JSON.parse(sessionData);
      return session.refreshTokens?.includes(refreshToken) || false;
    } catch (error) {
      this.logger.error(`Error checking refresh token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Check if a session is still valid
   * Returns false if session doesn't exist or doesn't match
   */
  async isSessionValid(userId: string, sessionId: string): Promise<boolean> {
    const sessionKey = `user:${userId}:session`;
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      return false;
    }

    try {
      const session = JSON.parse(sessionData);
      return session.sessionId === sessionId;
    } catch (error) {
      this.logger.error(`Error parsing session data for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Delete a user's session (used during logout)
   */
  async deleteSession(userId: string): Promise<void> {
    const sessionKey = `user:${userId}:session`;
    const sessionData = await this.redis.get(sessionKey);

    if (sessionData) {
      try {
        const session = JSON.parse(sessionData);
        // Delete reverse mapping
        await this.redis.del(`session:${session.sessionId}`);
      } catch (error) {
        this.logger.error(`Error deleting session mappings for user ${userId}:`, error);
      }
    }

    // Delete main session
    await this.redis.del(sessionKey);
    this.logger.log(`Session deleted for user ${userId}`);
  }

  /**
   * Get current session information
   */
  async getSession(userId: string): Promise<any> {
    const sessionKey = `user:${userId}:session`;
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      return null;
    }

    try {
      return JSON.parse(sessionData);
    } catch (error) {
      this.logger.error(`Error parsing session data for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Extend session expiry (useful for refresh token flow)
   */
  async extendSession(userId: string): Promise<void> {
    const sessionKey = `user:${userId}:session`;
    
    // Check if session exists
    const exists = await this.redis.get(sessionKey);
    if (exists) {
      // Extend TTL by another 7 days
      await this.redis.expire(sessionKey, 60 * 60 * 24 * 7);
      
      // Also extend reverse mapping
      try {
        const session = JSON.parse(exists);
        await this.redis.expire(`session:${session.sessionId}`, 60 * 60 * 24 * 7);
      } catch (error) {
        this.logger.error(`Error extending session for user ${userId}:`, error);
      }
    }
  }

  /**
   * Get session by session ID
   */
  async getSessionById(sessionId: string): Promise<any> {
    const userId = await this.redis.get(`session:${sessionId}`);
    
    if (!userId) {
      return null;
    }

    return this.getSession(userId);
  }
}