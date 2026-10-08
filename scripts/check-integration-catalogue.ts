import { IntegrationType } from '../src/common/enums/integration.enum';
import {
  INTEGRATION_CATALOGUE,
  listCatalogue,
  isOutboundType,
  isInboundType,
  validateIntegrationConfig,
} from '../src/modules/integrations/integration-catalogue';

let bad = 0;
const fail = (m: string) => { console.log('FAIL:', m); bad++; };

// 1. Every enum member has a manifest, and vice versa.
for (const value of Object.values(IntegrationType)) {
  if (!INTEGRATION_CATALOGUE[value]) fail(`no manifest for enum ${value}`);
}
for (const [key, manifest] of Object.entries(INTEGRATION_CATALOGUE)) {
  if (manifest.type !== key) fail(`manifest key ${key} declares type ${manifest.type}`);
}

// 2. Field keys unique per type; selects have options; showIf targets exist.
for (const manifest of listCatalogue()) {
  const keys = manifest.fields.map((f) => f.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) fail(`${manifest.type}: duplicate field keys ${dupes}`);
  for (const field of manifest.fields) {
    if (field.type === 'select' && !field.options?.length) {
      fail(`${manifest.type}.${field.key}: select with no options`);
    }
    if (field.showIf && !keys.includes(field.showIf.key)) {
      fail(`${manifest.type}.${field.key}: showIf targets unknown key ${field.showIf.key}`);
    }
    if (field.required && field.default !== undefined) {
      // Not an error, but a required field with a default can never fail
      // validation, which is worth knowing.
      console.log(`note: ${manifest.type}.${field.key} is required AND defaulted`);
    }
  }
}

// 3. An empty config fails exactly for the required fields.
for (const manifest of listCatalogue()) {
  const errors = validateIntegrationConfig(manifest.type, {});
  const requiredVisible = manifest.fields.filter((f) => f.required && !f.showIf).length;
  if (errors.length < requiredVisible) {
    fail(`${manifest.type}: ${requiredVisible} required fields but only ${errors.length} errors on empty config`);
  }
}

// 4. Direction helpers agree with the declared direction.
for (const manifest of listCatalogue()) {
  const out = isOutboundType(manifest.type);
  const inb = isInboundType(manifest.type);
  if (!out && !inb) fail(`${manifest.type}: neither inbound nor outbound`);
  if (manifest.direction === 'outbound' && inb) fail(`${manifest.type}: outbound but isInboundType true`);
  if (manifest.direction === 'inbound' && out) fail(`${manifest.type}: inbound but isOutboundType true`);
}

// 5. An inbound-only type with no adapter must have a push path, or it is dead.
for (const manifest of listCatalogue()) {
  if (!manifest.hasAdapter && !manifest.inboundPath && !manifest.adapterNote) {
    fail(`${manifest.type}: no adapter, no inbound path, and no note explaining why`);
  }
}

console.log(`\n${listCatalogue().length} types checked; ${bad} problem(s).`);
console.log('\nTypes:', listCatalogue().map((m) => `${m.type}[${m.category}/${m.direction}${m.hasAdapter ? '' : ' NO-ADAPTER'}]`).join('\n       '));
process.exit(bad ? 1 : 0);
