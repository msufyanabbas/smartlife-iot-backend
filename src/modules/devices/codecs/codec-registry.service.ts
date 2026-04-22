// src/modules/devices/codecs/codec-registry.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { IDeviceCodec, DecodedTelemetry } from './interfaces/base-codec.interface';

export interface ManufacturerCatalog {
  manufacturer: string;
  models: ModelEntry[];
}

export interface ModelEntry {
  model: string;         // e.g. "WS558"
  codecId: string;       // e.g. "milesight-ws558"
  protocol: string;      // e.g. "lorawan"
  description?: string;  // optional human-readable label
}

@Injectable()
export class CodecRegistryService {
  private readonly logger = new Logger(CodecRegistryService.name);
  private readonly codecs = new Map<string, IDeviceCodec>();

  // ── Registration ──────────────────────────────────────────────────────────

  registerCodec(codec: IDeviceCodec): void {
    this.codecs.set(codec.codecId, codec);
    this.logger.log(
      `Registered codec: ${codec.codecId} (${codec.manufacturer} — ${codec.supportedModels.join(', ')})`,
    );
  }

  // ── Direct lookup ─────────────────────────────────────────────────────────

  getCodec(codecId: string): IDeviceCodec | undefined {
    return this.codecs.get(codecId);
  }

  /**
   * Find the codec for a given manufacturer + model combination.
   * Case-insensitive on both sides.
   */
  findCodec(manufacturer: string, model: string): IDeviceCodec | undefined {
    const mfr = manufacturer.toLowerCase();
    const mdl = model.toLowerCase();

    for (const codec of this.codecs.values()) {
      if (
        codec.manufacturer.toLowerCase() === mfr &&
        codec.supportedModels.some((m) => m.toLowerCase() === mdl)
      ) {
        return codec;
      }
    }
    return undefined;
  }

  /**
   * Resolve a codecId from manufacturer + model.
   * Returns undefined if no match found.
   */
  resolveCodecId(manufacturer: string, model: string): string | undefined {
    return this.findCodec(manufacturer, model)?.codecId;
  }

  // ── Catalog (for frontend dropdowns) ─────────────────────────────────────

  /**
   * Returns the list of unique manufacturer names that have at least one
   * registered codec.  Used to populate the first dropdown.
   *
   * Excludes 'Generic' from the list because generic devices don't go
   * through the manufacturer/model selection flow.
   */
  listManufacturers(): string[] {
    const names = new Set<string>();
    for (const codec of this.codecs.values()) {
      if (codec.manufacturer !== 'Generic') {
        names.add(codec.manufacturer);
      }
    }
    return Array.from(names).sort();
  }

  /**
   * Returns all models for a given manufacturer, each entry carrying the
   * codecId and protocol so the frontend can display useful context.
   *
   * For a manufacturer that has multiple codecs (e.g. Milesight with both
   * WS558 and EM300), all models from all codecs are merged into one flat
   * list — one entry per model.
   */
  listModelsForManufacturer(manufacturer: string): ModelEntry[] {
    const models: ModelEntry[] = [];
    const mfr = manufacturer.toLowerCase();

    for (const codec of this.codecs.values()) {
      if (codec.manufacturer.toLowerCase() !== mfr) continue;

      for (const modelName of codec.supportedModels) {
        // Skip the generic wildcard
        if (modelName === '*') continue;

        models.push({
          model: modelName,
          codecId: codec.codecId,
          protocol: codec.protocol,
        });
      }
    }

    // Sort alphabetically by model name
    return models.sort((a, b) => a.model.localeCompare(b.model));
  }

  /**
   * Full catalog grouped by manufacturer — used by GET /codecs/manufacturers.
   */
  getCatalog(): ManufacturerCatalog[] {
    const byManufacturer = new Map<string, ModelEntry[]>();

    for (const codec of this.codecs.values()) {
      if (codec.manufacturer === 'Generic') continue;

      if (!byManufacturer.has(codec.manufacturer)) {
        byManufacturer.set(codec.manufacturer, []);
      }

      for (const modelName of codec.supportedModels) {
        if (modelName === '*') continue;
        byManufacturer.get(codec.manufacturer)!.push({
          model: modelName,
          codecId: codec.codecId,
          protocol: codec.protocol,
        });
      }
    }

    return Array.from(byManufacturer.entries())
      .map(([manufacturer, models]) => ({
        manufacturer,
        models: models.sort((a, b) => a.model.localeCompare(b.model)),
      }))
      .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer));
  }

  // ── Auto-detect ───────────────────────────────────────────────────────────

  detectCodec(
    payload: string | Buffer,
    metadata?: {
      fPort?: number;
      devEUI?: string;
      manufacturer?: string;
      model?: string;
    },
  ): IDeviceCodec | undefined {
    // Prefer explicit manufacturer + model
    if (metadata?.manufacturer && metadata?.model) {
      const codec = this.findCodec(metadata.manufacturer, metadata.model);
      if (codec?.canDecode(payload, metadata)) return codec;
    }

    // Fall back to canDecode probe across all codecs
    for (const codec of this.codecs.values()) {
      if (codec.canDecode(payload, metadata)) {
        this.logger.debug(`Auto-detected codec: ${codec.codecId}`);
        return codec;
      }
    }

    return undefined;
  }

  // ── Decode ────────────────────────────────────────────────────────────────

  /**
   * Decode a payload using the best available codec.
   *
   * Resolution priority:
   *  1. deviceMetadata.codecId  (explicit — fastest path)
   *  2. deviceMetadata.manufacturer + model  (catalog lookup)
   *  3. canDecode() auto-detection across all codecs  (last resort)
   *  4. Return raw payload wrapped in { raw_data, decoded: false }
   */
  decode(
    payload: any,
    deviceMetadata?: {
      codecId?: string;
      manufacturer?: string;
      model?: string;
      fPort?: number;
      devEUI?: string;
    },
  ): DecodedTelemetry {
    // ── Already decoded JSON object ───────────────────────────────────────
    if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      if (this.looksLikeTelemetry(payload)) return payload as DecodedTelemetry;
      if (payload.data && typeof payload.data === 'object') return payload.data as DecodedTelemetry;
      return payload as DecodedTelemetry;
    }

    // ── Find codec ────────────────────────────────────────────────────────
    let codec: IDeviceCodec | undefined;

    // 1. Explicit codecId
    if (deviceMetadata?.codecId) {
      codec = this.getCodec(deviceMetadata.codecId);
      if (codec) this.logger.debug(`Using codec by ID: ${codec.codecId}`);
    }

    // 2. manufacturer + model → codecId resolution
    if (!codec && deviceMetadata?.manufacturer && deviceMetadata?.model) {
      codec = this.findCodec(deviceMetadata.manufacturer, deviceMetadata.model);
      if (codec) this.logger.debug(`Using codec by manufacturer/model: ${codec.codecId}`);
    }

    // 3. Auto-detection
    if (!codec) {
      codec = this.detectCodec(payload, deviceMetadata);
    }

    if (!codec) {
      this.logger.warn(`No codec found for payload — returning raw`);
      return this.wrapRaw(payload);
    }

    // ── Decode ────────────────────────────────────────────────────────────
    try {
      const decoded = codec.decode(payload, deviceMetadata?.fPort);
      this.logger.debug(`Decoded with ${codec.codecId}: ${JSON.stringify(decoded)}`);
      return decoded;
    } catch (err) {
      this.logger.error(`Codec ${codec.codecId} threw: ${(err as Error).message}`);
      return this.wrapRaw(payload);
    }
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(
    command: { type: string; params?: any },
    deviceMetadata: { codecId: string },
  ): ReturnType<IDeviceCodec['encode']> {
    const codec = this.getCodec(deviceMetadata.codecId);
    if (!codec) throw new Error(`Codec not found: ${deviceMetadata.codecId}`);
    return codec.encode(command);
  }

  // ── List (admin API) ──────────────────────────────────────────────────────

  listCodecs() {
    return Array.from(this.codecs.values()).map((c) => ({
      codecId: c.codecId,
      manufacturer: c.manufacturer,
      models: c.supportedModels,
      protocol: c.protocol,
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private looksLikeTelemetry(obj: any): boolean {
    const knownFields = [
      'temperature', 'humidity', 'pressure', 'batteryLevel',
      'motion', 'occupancy', 'latitude', 'longitude',
    ];
    return knownFields.some((f) => f in obj);
  }

  private wrapRaw(payload: any): DecodedTelemetry {
    let raw: string;
    if (Buffer.isBuffer(payload)) raw = payload.toString('hex');
    else if (typeof payload === 'string') raw = payload;
    else raw = JSON.stringify(payload);

    return { raw_data: raw, decoded: false, error: 'No codec available for this device' };
  }
}