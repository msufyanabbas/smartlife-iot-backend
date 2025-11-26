import { JwtConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';

export default registerAs(
  'jwt',
  (): JwtConfig => ({
    // Access Token
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRATION,

    // Refresh Token
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRATION,

    // Email Verification Token
    verificationSecret: process.env.JWT_VERIFICATION_SECRET,
    verificationExpiresIn: process.env.JWT_VERIFICATION_EXPIRATION,

    // Password Reset Token
    resetSecret: process.env.JWT_RESET_SECRET,
    resetExpiresIn: process.env.JWT_RESET_EXPIRATION,

    // Token Options
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  }),
);
