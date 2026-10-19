/**
 * Verifies the AI module's pure logic and its tenant scoping.
 *
 *   createdb aicheck && npm run verify:ai aicheck
 *
 * No provider is called — there is no API key here and a verification that
 * needs one is a verification nobody runs. What IS covered is everything that
 * can be wrong without a network: credential encryption, prompt templating,
 * response normalisation, and the tenant predicate on every read.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { AiService, normaliseResponse } from '../src/modules/ai/ai.service';
import { substitute } from '../src/modules/nodes/processors/ai-request-node';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  maskSecret,
} from '../src/common/utils/secret-box';
import { AI_PROVIDER_CATALOGUE, getAiProviderManifest } from '../src/modules/ai/ai-provider.catalogue';

const database = process.argv[2] ?? 'aicheck';

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};
const section = (t: string) => console.log(`\n── ${t} ─────────────`);

const T_A = randomUUID();
const T_B = randomUUID();

(async () => {
  // ── 1. The secret box ─────────────────────────────────────────────────────
  section('1. Credential encryption');
  process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes of hex

  const key = 'sk-proj-abcdefghijklmnop';
  const box = encryptSecret(key);
  ok('ciphertext is version-prefixed', box.startsWith('v1:'), box.slice(0, 12));
  ok('the plaintext does not appear in the ciphertext', !box.includes(key));
  ok('it round-trips', decryptSecret(box) === key);
  ok('isEncrypted() recognises it', isEncrypted(box));
  ok('encrypting twice yields different ciphertext (random IV)',
    encryptSecret(key) !== encryptSecret(key));
  ok('the mask shows enough to recognise, not enough to use',
    maskSecret(key) === 'sk-p…mnop', maskSecret(key));

  let tampered = false;
  try {
    const parts = box.split(':');
    // flip a character in the ciphertext body
    parts[3] = parts[3].slice(0, -1) + (parts[3].slice(-1) === 'A' ? 'B' : 'A');
    decryptSecret(parts.join(':'));
  } catch {
    tampered = true;
  }
  ok('a tampered ciphertext is REJECTED, not silently mangled (GCM auth tag)',
    tampered);

  let wrongKey = false;
  const saved = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = 'b'.repeat(64);
  try {
    decryptSecret(box);
  } catch {
    wrongKey = true;
  }
  ok('a changed key fails loudly rather than returning garbage', wrongKey);
  process.env.CREDENTIALS_ENCRYPTION_KEY = saved;

  delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  const plain = encryptSecret(key);
  ok('with no key set it degrades reversibly instead of throwing',
    decryptSecret(plain) === key);
  ok('and does NOT claim to be encrypted', !isEncrypted(plain));
  process.env.CREDENTIALS_ENCRYPTION_KEY = saved;

  // ── 2. Prompt templating ──────────────────────────────────────────────────
  section('2. Prompt templating');
  const msg: any = {
    data: { temperature: 42, status: 'ok', nested: { a: 1 } },
    metadata: { deviceName: 'Lobby sensor', tenantId: T_A },
  };
  ok('$[key] substitutes message data',
    substitute('temp is $[temperature]', msg) === 'temp is 42');
  ok('${key} substitutes metadata',
    substitute('on ${deviceName}', msg) === 'on Lobby sensor');
  ok('$[*] inlines the whole data object',
    substitute('$[*]', msg) === JSON.stringify(msg.data));
  ok('${*} inlines the whole metadata object',
    substitute('${*}', msg) === JSON.stringify(msg.metadata));
  ok('an object value is JSON, not [object Object]',
    substitute('$[nested]', msg) === '{"a":1}');
  ok('a MISSING key renders empty, never the literal placeholder',
    substitute('x$[nope]y', msg) === 'xy', substitute('x$[nope]y', msg));
  ok('both syntaxes in one template',
    substitute('$[temperature] on ${deviceName}', msg) === '42 on Lobby sensor');
  ok('an empty template is empty, not "undefined"', substitute(undefined, msg) === '');

  // ── 3. Response normalisation ─────────────────────────────────────────────
  section('3. Response normalisation');
  ok('a JSON object passes through as the data',
    JSON.stringify(normaliseResponse('{"a":1}')) === '{"a":1}');
  ok('plain prose is wrapped under response',
    (normaliseResponse('all good') as any).response === 'all good');
  ok('a JSON ARRAY is wrapped, not spread',
    Array.isArray((normaliseResponse('[1,2]') as any).response) === false
      ? (normaliseResponse('[1,2]') as any).response === '[1,2]'
      : true,
    normaliseResponse('[1,2]'));
  ok('a markdown-fenced object is unwrapped',
    JSON.stringify(normaliseResponse('```json\n{"a":2}\n```')) === '{"a":2}',
    normaliseResponse('```json\n{"a":2}\n```'));
  ok('malformed JSON falls back to text rather than throwing',
    (normaliseResponse('{not json') as any).response === '{not json');

  // ── 4. The provider catalogue ─────────────────────────────────────────────
  section('4. Provider catalogue');
  ok('every provider has at least one field',
    AI_PROVIDER_CATALOGUE.every((m) => m.fields.length > 0));
  ok('field keys are unique within each provider',
    AI_PROVIDER_CATALOGUE.every(
      (m) => new Set(m.fields.map((f) => f.key)).size === m.fields.length,
    ));
  ok('Anthropic is flagged as having no schemaless JSON mode',
    getAiProviderManifest('anthropic')?.supportsSchemalessJson === false);
  ok('OpenAI is flagged as having one',
    getAiProviderManifest('openai')?.supportsSchemalessJson === true);
  ok('an unknown provider has no manifest',
    getAiProviderManifest('nope' as any) === undefined);

  // ── 5. Tenant scoping, against a real database ────────────────────────────
  section('5. Tenant scoping');
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });
  await ds.initialize();

  for (const [i, id] of [T_A, T_B].entries()) {
    await ds.query('INSERT INTO tenants (id,name,email) VALUES ($1,$2,$3)', [
      id, `AI tenant ${i}`, `ai${i}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }

  const service = new AiService(ds.getRepository(entities.AiModel) as any);

  const created = await service.create(T_A, {
    name: 'Primary',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    apiKey: key,
  } as any);
  ok('a model is created', !!created.id);

  const row = await ds.query(
    'SELECT "apiKeyEncrypted" FROM ai_models WHERE id = $1',
    [created.id],
  );
  ok('the key is stored as ciphertext, not plaintext',
    isEncrypted(row[0].apiKeyEncrypted) && !row[0].apiKeyEncrypted.includes(key));

  const fetched = await service.findOne(created.id, T_A);
  ok('a normal read does NOT return the credential',
    (fetched as any).apiKeyEncrypted === undefined,
    Object.keys(fetched));

  let crossTenant = false;
  try {
    await service.findOne(created.id, T_B);
  } catch {
    crossTenant = true;
  }
  ok("tenant B cannot read tenant A's model", crossTenant);

  ok("tenant B's list is empty", (await service.findAll(T_B)).length === 0);

  // An update with no apiKey must not wipe the stored one.
  await service.update(created.id, T_A, { name: 'Primary renamed' } as any);
  const after = await ds.query(
    'SELECT "apiKeyEncrypted", name FROM ai_models WHERE id = $1',
    [created.id],
  );
  ok('updating without an apiKey keeps the stored credential',
    decryptSecret(after[0].apiKeyEncrypted) === key && after[0].name === 'Primary renamed');

  // Switching provider must re-validate: azure needs an endpoint the openai
  // row never had.
  let switchRefused = false;
  try {
    await service.update(created.id, T_A, {
      provider: 'azure_openai', modelId: 'my-deployment',
    } as any);
  } catch (e: any) {
    switchRefused = /endpoint/i.test(e?.message ?? '');
  }
  ok('switching provider re-validates the NEW provider required fields',
    switchRefused);

  let badProvider = false;
  try {
    await service.create(T_A, { name: 'x', provider: 'bogus', modelId: 'm' } as any);
  } catch {
    badProvider = true;
  }
  ok('an unknown provider is refused', badProvider);

  let missingField = false;
  try {
    // Azure requires an endpoint; omitting it must fail with a clear message.
    await service.create(T_A, {
      name: 'azure', provider: 'azure_openai', modelId: 'dep', apiKey: 'k',
    } as any);
  } catch (e: any) {
    missingField = /endpoint/i.test(e?.message ?? '');
  }
  ok('a missing required provider field is named in the error', missingField);

  await ds.destroy();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — credentials encrypted, prompts templated, reads tenant-scoped',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
