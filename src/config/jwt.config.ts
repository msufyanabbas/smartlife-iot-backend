// src/config/jwt.config.ts
import { JwtConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';

export default registerAs(
  'jwt',
  (): JwtConfig => {
    // Validate required secrets
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    if (!process.env.JWT_REFRESH_SECRET) {
      throw new Error('JWT_REFRESH_SECRET environment variable is required');
    }

    return {
      // Access Token
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_EXPIRATION || '15m',

      // Refresh Token
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRATION || '7d',

      // Email Verification Token
      verificationSecret: process.env.JWT_VERIFICATION_SECRET || process.env.JWT_SECRET,
      verificationExpiresIn: process.env.JWT_VERIFICATION_EXPIRATION || '24h',

      // Password Reset Token
      resetSecret: process.env.JWT_RESET_SECRET || process.env.JWT_SECRET,
      resetExpiresIn: process.env.JWT_RESET_EXPIRATION || '1h',

      // Token Options
      issuer: process.env.JWT_ISSUER || 'smartlife-iot-platform',
      audience: process.env.JWT_AUDIENCE || 'smartlife-users',
    };
  },
);