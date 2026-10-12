/**
 * Builds the Swagger document for every controller, on its own.
 *
 *   npm run check:swagger
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `SwaggerModule.createDocument()` runs at the very end of `bootstrap()`, and
 * when it throws, the process exits **1 with the application otherwise fully
 * initialised** — every module logs "dependencies initialized" and then the
 * container dies. In a container that is a crash loop with a stack trace
 * pointing into `@nestjs/swagger`, naming a property but not the DTO it is on.
 *
 * A typecheck cannot see this: the decorator metadata is only assembled at
 * runtime. Neither can the verification scripts, which construct services by
 * hand and never touch a controller's Swagger metadata.
 *
 * This script registers each controller into a bare Nest app — **no
 * providers, no database, no Kafka** — and asks Swagger to describe it. That
 * is enough to reproduce the failure in about a second, and it is the only
 * part of bootstrap that was not covered by anything.
 *
 * ── The rule it enforces ───────────────────────────────────────────────────
 * On a **query or path parameter**, `@ApiProperty({ enum: X })` must also
 * carry `enumName`. Without it, `SchemaObjectFactory.createFromModel()` skips
 * `createEnumParam()`, falls through to `createQueryOrParamSchema()`, and
 * finds `param.type` holding the enum OBJECT. A TypeScript enum is a plain
 * object, so `isObjectLiteral()` is true, and Swagger then walks its keys as
 * if they were DTO properties — reporting the first member as
 *
 *     A circular dependency has been detected (property key: "DEVICE")
 *
 * which is not a circular dependency at all. Body DTOs are unaffected, which
 * is why this only ever bites on a `@Query()` or `@Param()` class.
 */
import 'reflect-metadata';
import { Module, Controller } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Runs against `dist` by default, NOT `src`.
 *
 * This is the whole point of the script. `dist` is built by **SWC**, and SWC
 * emits different `design:type` metadata than tsc for an enum-typed property:
 * tsc reduces a string enum to `String`, SWC keeps a reference to the enum
 * OBJECT. Swagger then sees `isObjectLiteral(param.type) === true` on a query
 * parameter and walks the enum's members as if they were DTO properties.
 *
 * So the ts-node version of this check passes while the shipped container
 * crash-loops — which is exactly what happened. Pass `src` as argv[2] to
 * compare the two.
 */
const WHICH = process.argv[2] === 'src' ? 'src' : 'dist';
const SRC = join(__dirname, '..', WHICH);
const EXT = WHICH === 'src' ? '.controller.ts' : '.controller.js';

/** Every *.controller.ts under src/, so a new module is covered automatically. */
const findControllerFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findControllerFiles(full, out);
    else if (entry.endsWith(EXT) && !entry.includes('.spec.'))
      out.push(full);
  }
  return out;
};

(async () => {
  const files = findControllerFiles(SRC).sort();
  console.log(`Describing ${files.length} controller files from ${WHICH}/\n`);

  // ── One document for every controller, exactly as bootstrap() builds it ──
  //
  // Describing controllers one at a time is NOT equivalent: `createDocument`
  // accumulates a single `schemas` map across the whole app, so a clash or a
  // malformed parameter can surface only once everything shares it. The first
  // version of this script passed per-controller while production still
  // crashed, which is the whole reason it builds one document now.
  const controllers: any[] = [];
  for (const file of files) {
    let exported: Record<string, any>;
    try {
      exported = require(file);
    } catch (error: any) {
      console.error(`  ✗ ${file.replace(SRC + '/', '')} could not be imported: ${error?.message}`);
      process.exit(1);
    }
    for (const value of Object.values(exported)) {
      if (
        typeof value === 'function' &&
        Reflect.hasMetadata('path', value) &&
        value !== Controller
      ) {
        controllers.push(value);
      }
    }
  }
  console.log(`${controllers.length} controllers in one document\n`);

  // Stub every class dependency reachable from a controller or one of its
  // interceptors/guards, plus the string tokens the DI container uses.
  const tokens = new Set<any>();
  const collect = (target: any) => {
    const deps: any[] = Reflect.getMetadata('design:paramtypes', target) ?? [];
    for (const dep of deps) if (typeof dep === 'function') tokens.add(dep);
    for (const key of ['__interceptors__', '__guards__', '__filters__']) {
      const attached: any[] = Reflect.getMetadata(key, target) ?? [];
      for (const item of attached) {
        const cls = typeof item === 'function' ? item : item?.constructor;
        if (typeof cls === 'function') {
          tokens.add(cls);
          collect(cls);
        }
      }
    }
  };
  for (const controller of controllers) {
    collect(controller);
    for (const method of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[method];
      if (typeof handler === 'function') collect(handler);
    }
  }

  const providers: any[] = [...tokens].map((token) => ({
    provide: token,
    useValue: {},
  }));
  for (const stringToken of ['REDIS_SERVICE', 'CACHE_MANAGER']) {
    providers.push({ provide: stringToken, useValue: {} });
  }

  @Module({ controllers, providers })
  class ProbeModule {}

  let failures = 0;
  try {
    const app = await NestFactory.create(ProbeModule, {
      logger: false,
      abortOnError: false,
    });
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('probe').setVersion('1').build(),
    );
    await app.close();
    console.log('  ✓ the full Swagger document builds');
  } catch (error: any) {
    failures++;
    const message = error?.message ?? String(error);
    console.error(`  ✗ ${message.split('\n')[0]}`);
    const key = /property key: "([^"]+)"/.exec(message)?.[1];
    if (key) {
      console.error(
        `\n      Member "${key}" belongs to an enum used on a @Query()/@Param() ` +
          `DTO with no enumName.\n      Add  enumName: '<EnumName>'  beside the ` +
          `enum: option on that property.`,
      );
    }
  }

  console.log(
    failures
      ? '\nFAIL — the Swagger document cannot be built; bootstrap() will exit 1 ' +
          'whenever ENABLE_SWAGGER is on'
      : '\nPASS — the full Swagger document builds',
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('FAILED:', error?.message);
  process.exit(1);
});
