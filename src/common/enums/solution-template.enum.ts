export enum SolutionTemplateCategory {
  SMART_FACTORY = 'smart_factory',
  SMART_HOME = 'smart_home',
  SMART_BUILDING = 'smart_building',
  SMART_CITY = 'smart_city',

  // ── Categories used by the 8 system templates ─────────────────────────────
  SMART_AGRICULTURE = 'smart_agriculture',
  SMART_ENERGY = 'smart_energy',
  SMART_RETAIL = 'smart_retail',
  SMART_WATER = 'smart_water',
  SMART_FACILITY = 'smart_facility',

  // ── Legacy values ─────────────────────────────────────────────────────────
  // Superseded by the smart_* values above, but retained because existing rows
  // still reference them — dropping them from the PG enum would orphan data.
  AGRICULTURE = 'agriculture',
  HEALTHCARE = 'healthcare',
  ENERGY = 'energy',
  LOGISTICS = 'logistics',
  RETAIL = 'retail',
  WATER = 'water',
  CLIMATE = 'climate',
  EDUCATION = 'education',
}