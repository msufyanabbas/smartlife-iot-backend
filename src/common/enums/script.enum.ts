export enum ScriptType {
  PROCESSING = 'processing',
  FILTER = 'filter',
  AGGREGATION = 'aggregation',
  VALIDATION = 'validation',
  TRANSFORMATION = 'transformation',
  // Returns a plain object that is merged into the message metadata.
  // Added for ThingsBoard parity — the rule engine's ENRICHMENT node needs it.
  ENRICHMENT = 'enrichment',
}
