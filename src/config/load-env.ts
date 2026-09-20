// src/config/load-env.ts
//
// Single, deterministic entry point for loading .env files.
//
// WHY THIS FILE EXISTS
// --------------------
// The codebase reads `process.env` in three different phases, and they do NOT
// happen in the order you would expect:
//
//   1. Decorator evaluation (`@WebSocketGateway({ cors: { origin: ... } })`)
//      runs at *import* time — before any Nest module is instantiated.
//   2. `AppDataSource` is constructed at import time too.
//   3. `ConfigModule.forRoot()` only populates `process.env` at module init,
//      which is phase 3 — far too late for 1 and 2.
//
// Previously `data-source.ts` happened to call dotenv at import, and everything
// else relied on that side effect firing first. That is load-order luck, not a
// design. Importing this module (for its side effect) at the top of `main.ts`
// and `data-source.ts` makes the load explicit and ordered.
//
// FILE RESOLUTION
// ---------------
// `ENV_FILE` wins if set (useful for CI and one-off scripts). Otherwise we look
// for `.env.<NODE_ENV>` and fall back to `.env`. Both are loaded when present,
// with the environment-specific file taking precedence, so a shared `.env` can
// hold common values while `.env.production` overrides the deployment-specific
// ones.
//
// Real environment variables (exported in the shell, injected by Docker/K8s)
// always win: dotenv never overwrites a variable that is already set.

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

let loaded = false;

export function loadEnvFiles(): string[] {
  if (loaded) return [];
  loaded = true;

  const cwd = process.cwd();
  const nodeEnv = process.env.NODE_ENV;

  const candidates = [
    process.env.ENV_FILE,
    nodeEnv ? `.env.${nodeEnv}` : undefined,
    '.env',
  ].filter((f): f is string => Boolean(f));

  const used: string[] = [];

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate);
    if (existsSync(fullPath)) {
      // `override: false` is the dotenv default and is what we want: the first
      // file to define a key wins, and a real shell/container variable beats
      // every file.
      loadDotenv({ path: fullPath });
      used.push(candidate);
    }
  }

  return used;
}

/**
 * Resolved env file paths, in precedence order, for `ConfigModule.forRoot()`.
 * Nest applies the same "first file wins" rule, so the order matches the one
 * used above and the two loaders can never disagree.
 */
export function envFilePaths(): string[] {
  const nodeEnv = process.env.NODE_ENV;
  return [
    process.env.ENV_FILE,
    nodeEnv ? `.env.${nodeEnv}` : undefined,
    '.env',
  ].filter((f): f is string => Boolean(f));
}

// Side effect: loading this module loads the environment.
loadEnvFiles();
