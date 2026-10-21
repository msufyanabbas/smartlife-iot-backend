import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AiService } from './ai.service';
// TYPE-ONLY. A value import here puts ai-insights.service on the module-load
// path of the entire telemetry graph, which closes a cycle back through
// NotificationsService — `npm run check:swagger` caught it as
// "Cannot access 'NotificationsService' before initialization", i.e. a TDZ
// error from circular ES modules, which at boot is a crash-loop.
// `ModuleRef` resolves the real service after every module is constructed,
// so there is no import edge at all. Reimplementing the telemetry reads here
// instead would lose `resolveDeviceForUser`'s tenant scoping, which is the
// mistake the Tuya path already made once (§4d).
import type { TelemetryService } from '@modules/telemetry/telemetry.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AI insights over device telemetry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The Trendz-shaped slice: point it at a device and a window, and it answers
 * in structured JSON — summary, observed trends, anomalies, recommendations.
 *
 * BE CLEAR ABOUT WHAT THIS IS. Trendz does statistical and ML work —
 * Prophet/ARIMA forecasting, unsupervised anomaly scoring trained per device
 * profile, with models persisted and retrained on a schedule. This does none
 * of that. It computes real descriptive statistics in code and asks a language
 * model to interpret them. That is genuinely useful for "what happened on this
 * sensor last week", and it is NOT forecasting; an LLM asked to predict a
 * number will produce a confident one with nothing behind it. The prompt says
 * so explicitly, and the response schema has no forecast field, because the
 * reliable way to stop a model inventing predictions is to give it nowhere to
 * put them.
 *
 * Failures carry a machine-readable `code` alongside the message, because
 * the UI shows a different empty state for "no model configured" than for
 * "no telemetry in this window" — and matching on English prose means a
 * reworded message silently degrades one into a generic error.
 *
 * The statistics are computed HERE, not by the model. Handing an LLM 10,000
 * raw readings and asking for the mean is slow, expensive and wrong; handing
 * it an accurate summary and asking what it means plays to what it is good at.
 */

export interface DeviceInsightOptions {
  deviceId: string;
  userId: string;
  tenantId: string;
  /** Registered AI model to use. Falls back to the tenant's first enabled one. */
  modelId?: string;
  startDate?: string;
  endDate?: string;
  /** Extra operator context, e.g. "this is a cold-store freezer, target -18C". */
  context?: string;
}

/**
 * Exported because it appears in the inferred return type of a public
 * controller method, and `tsconfig.json` sets `declaration: true`: tsc has to
 * name the type in the emitted .d.ts and cannot name one that is private to
 * its module (TS4053). `npm run build` uses SWC, which does not typecheck, so
 * this surfaced only under `tsc --noEmit`.
 */
export interface SeriesSummary {
  key: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  first: number;
  last: number;
  /** Change from first to last, as a percentage of the first value. */
  changePct: number | null;
  /** Readings more than 3 standard deviations from the mean. */
  outlierCount: number;
}

const INSIGHT_SCHEMA = {
  title: 'DeviceInsight',
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two or three sentences on how the device behaved.',
    },
    trends: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          direction: { type: 'string', enum: ['rising', 'falling', 'stable', 'volatile'] },
          description: { type: 'string' },
        },
        required: ['key', 'direction', 'description'],
      },
    },
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          description: { type: 'string' },
        },
        required: ['key', 'severity', 'description'],
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    dataQualityNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'trends', 'anomalies', 'recommendations'],
  additionalProperties: false,
} as const;

@Injectable()
export class AiInsightsService implements OnModuleInit {
  private readonly logger = new Logger(AiInsightsService.name);

  private telemetry!: TelemetryService;

  constructor(
    private readonly ai: AiService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    // `strict: false` so it is found wherever TelemetryModule is registered.
    this.telemetry = this.moduleRef.get<TelemetryService>(
      'TelemetryService',
      { strict: false },
    );
  }

  async analyseDevice(options: DeviceInsightOptions) {
    const end = options.endDate ?? new Date().toISOString();
    const start =
      options.startDate ??
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // `getStatistics` resolves the device THROUGH the caller, so a user who
    // cannot see this device gets a 404 here rather than having their prompt
    // quietly answered from another tenant's data (§4g).
    const stats = await this.telemetry.getStatistics(
      options.deviceId,
      options.userId,
      start,
      end,
    );

    const keys: string[] = Array.isArray(stats?.keys)
      ? stats.keys
      : Object.keys(stats?.statistics ?? {});

    if (keys.length === 0) {
      throw new BadRequestException({
        code: 'NO_TELEMETRY_IN_WINDOW',
        message:
          'This device has no telemetry in the selected window, so there is ' +
          'nothing to analyse.',
      });
    }

    // Cap the number of series: a device reporting 60 keys would produce a
    // prompt that costs real money and that the model reads less carefully
    // than it would read ten.
    const summaries: SeriesSummary[] = [];
    // Why these are counted rather than discarded: "no numeric telemetry
    // found" is the wrong thing to tell someone looking at a chart with a
    // reading on it. The two reasons a key produces no summary are entirely
    // different problems, and only one of them is about the data being
    // non-numeric:
    //
    //   • the key is textual          → nothing to analyse, ever
    //   • the key has ONE reading     → analysable as soon as a second arrives
    //
    // A device that has just been provisioned hits the second case, and the
    // old message sent its owner looking for a telemetry problem that did not
    // exist.
    const tooShort: Array<{ key: string; readings: number }> = [];
    const nonNumeric: string[] = [];

    for (const key of keys.slice(0, 12)) {
      const points = await this.telemetry.getTimeSeries(
        options.deviceId,
        options.userId,
        key,
        start,
        end,
        2000,
      );
      const summary = summarise(key, points);
      if (summary) {
        summaries.push(summary);
        continue;
      }

      const numericCount = (points ?? []).filter((p: any) =>
        Number.isFinite(Number(p?.value ?? p?.[key] ?? p?.data?.[key])),
      ).length;

      if (numericCount === 0) nonNumeric.push(key);
      else tooShort.push({ key, readings: numericCount });
    }

    if (summaries.length === 0) {
      // Ordered by what the reader can act on: a short series resolves itself,
      // a non-numeric one never will.
      if (tooShort.length > 0) {
        const worst = tooShort.sort((a, b) => b.readings - a.readings)[0];
        throw new BadRequestException({
          code: 'NOT_ENOUGH_READINGS',
          message:
            `This device has only ${worst.readings} reading(s) for ` +
            `"${worst.key}" in the selected window, and at least ${MIN_POINTS_PER_SERIES} ` +
            'are needed to describe a trend. Widen the window, or wait for ' +
            'the device to report again.',
          details: {
            minimumReadings: MIN_POINTS_PER_SERIES,
            keys: tooShort,
            window: { start, end },
          },
        });
      }

      throw new BadRequestException({
        code: 'NO_NUMERIC_TELEMETRY',
        message:
          nonNumeric.length > 0
            ? `This device reports ${nonNumeric.length} key(s) in this window ` +
              `(${nonNumeric.slice(0, 5).join(', ')}) but none of them are ` +
              'numeric, so there is nothing to compute statistics over.'
            : 'No numeric telemetry found to analyse in this window.',
        details: { nonNumericKeys: nonNumeric, window: { start, end } },
      });
    }

    const modelId =
      options.modelId ??
      (await this.ai.resolveDefaultModel(options.tenantId))?.id;
    if (!modelId) {
      throw new BadRequestException({
        code: 'NO_AI_MODEL_CONFIGURED',
        message: 'No AI model is configured. Add one under Settings → AI models.',
      });
    }

    const completion = await this.ai.complete(modelId, options.tenantId, {
      systemPrompt:
        'You are an IoT analyst. You are given accurate pre-computed ' +
        'statistics for one device over a time window — you are NOT given ' +
        'the raw readings, and you must not invent any number that is not ' +
        'in the input. Do not forecast or predict future values: you have no ' +
        'model for that. If the data is too sparse or too short to support a ' +
        'conclusion, say so in dataQualityNotes instead of guessing.',
      userPrompt: buildPrompt(summaries, start, end, options.context),
      responseFormat: 'JSON_SCHEMA',
      schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
      timeoutSeconds: 120,
    });

    return {
      deviceId: options.deviceId,
      window: { start, end },
      // The statistics are returned alongside the narrative so the reader can
      // check the model against the numbers it was given.
      statistics: summaries,
      insight: completion.data,
      model: completion.model,
      usage: completion.usage,
    };
  }
}

/**
 * The fewest readings a series needs before it can be described.
 *
 * Two is the floor at which `changePct`, `stdDev` and first/last mean
 * anything at all; one reading is a value, not a trend. Named rather than
 * inlined because the error message quotes it — a threshold the caller is
 * told about must not be able to drift away from the one enforced.
 */
const MIN_POINTS_PER_SERIES = 2;

function summarise(key: string, points: any[]): SeriesSummary | null {
  const values = (points ?? [])
    .map((p) => Number(p?.value ?? p?.[key] ?? p?.data?.[key]))
    .filter((v) => Number.isFinite(v));

  if (values.length < MIN_POINTS_PER_SERIES) return null;

  const count = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;
  const stdDev = Math.sqrt(variance);
  const first = values[0];
  const last = values[count - 1];

  return {
    key,
    count,
    min: round(min),
    max: round(max),
    mean: round(mean),
    stdDev: round(stdDev),
    first: round(first),
    last: round(last),
    // Guard the divide: a series that starts at exactly zero has no
    // meaningful percentage change, and Infinity in a prompt is noise.
    changePct: first === 0 ? null : round(((last - first) / Math.abs(first)) * 100),
    outlierCount:
      stdDev === 0 ? 0 : values.filter((v) => Math.abs(v - mean) > 3 * stdDev).length,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function buildPrompt(
  summaries: SeriesSummary[],
  start: string,
  end: string,
  context?: string,
): string {
  const lines = summaries.map(
    (s) =>
      `- ${s.key}: n=${s.count}, min=${s.min}, max=${s.max}, mean=${s.mean}, ` +
      `stdDev=${s.stdDev}, first=${s.first}, last=${s.last}, ` +
      `change=${s.changePct === null ? 'n/a' : `${s.changePct}%`}, ` +
      `readings beyond 3σ=${s.outlierCount}`,
  );

  return [
    `Window: ${start} to ${end}`,
    context ? `Operator context: ${context}` : null,
    '',
    'Per-metric statistics:',
    ...lines,
    '',
    'Interpret these statistics. Call out metrics that moved materially, ' +
      'metrics that look unstable relative to their own spread, and any ' +
      'sign of a sensor fault such as a flat line or an implausible range.',
  ]
    .filter(Boolean)
    .join('\n');
}
