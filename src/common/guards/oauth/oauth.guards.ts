import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}

@Injectable()
export class GitHubAuthGuard extends AuthGuard('github') {}

@Injectable()
export class AppleAuthGuard extends AuthGuard('apple') {}
