// src/common/utils/xlsx.util.ts
//
// One place that turns tabular data into a real .xlsx workbook.
//
// ── Why a shared helper rather than a branch in each exporter ───────────────
// Two surfaces need XLSX — `ReportGeneratorService.render()` and
// `POST /analytics/export` — and they would otherwise each grow their own
// column-width maths, their own date handling and their own idea of what a
// cell containing an object should look like. A spreadsheet that formats the
// same value two different ways depending on which screen produced it is the
// failure mode this avoids.
//
// ── exceljs is imported lazily ──────────────────────────────────────────────
// It is a ~5 MB dependency that pulls in a zip writer, and the overwhelming
// majority of requests on this process never produce a spreadsheet. The
// require happens on the first XLSX render and is cached by Node's module
// cache after that, so the cost is paid once by whoever asks for one, not by
// every boot.

export interface XlsxColumn {
  /** Key into each row object. */
  key: string;
  /** Header text. */
  label: string;
}

export interface XlsxSheet {
  /** Sheet tab name. Excel rejects >31 chars and the characters in SHEET_NAME_ILLEGAL. */
  name: string;
  columns: XlsxColumn[];
  rows: Array<Record<string, unknown>>;
  /**
   * Free-text lines written above the table, each in column A. Used for the
   * same cover block the PDF renderer prints — period, row count, truncation.
   */
  notes?: string[];
}

export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel forbids these in a sheet name, and silently corrupts the file if present. */
const SHEET_NAME_ILLEGAL = /[*?:/\\[\]]/g;

/** Excel's own hard limit. A longer name makes the workbook unopenable. */
const SHEET_NAME_MAX = 31;

/** Beyond this a column is a wall of text; Excel users widen it themselves. */
const MAX_COLUMN_WIDTH = 60;
const MIN_COLUMN_WIDTH = 10;

/**
 * A cell value Excel can store.
 *
 * Dates are passed through as `Date` so they land as real date cells rather
 * than strings — the whole point of choosing XLSX over CSV is that the
 * spreadsheet can sort and filter on them. Objects and arrays are JSON, which
 * is what the CSV and PDF renderers do too, so a jsonb column reads the same
 * in all three formats.
 */
const toCellValue = (value: unknown): string | number | boolean | Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (type === 'boolean' || type === 'string') return value as boolean | string;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const sanitiseSheetName = (name: string, fallback = 'Sheet1'): string => {
  const cleaned = (name ?? '').replace(SHEET_NAME_ILLEGAL, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, SHEET_NAME_MAX);
};

/**
 * Build an .xlsx workbook and return it as a Buffer.
 *
 * Header row is bold on a grey fill and frozen, and an autofilter is applied
 * over the table — a 50,000-row export is unusable without both.
 */
export async function buildXlsxBuffer(sheets: XlsxSheet[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const input = sheets.length > 0 ? sheets : [{ name: 'Sheet1', columns: [], rows: [] }];

  input.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(
      sanitiseSheetName(sheet.name, `Sheet${index + 1}`),
    );

    for (const note of sheet.notes ?? []) {
      worksheet.addRow([note]);
    }
    const headerRowNumber = (sheet.notes?.length ?? 0) + (sheet.notes?.length ? 2 : 1);
    if (sheet.notes?.length) worksheet.addRow([]);

    const columns = sheet.columns.length
      ? sheet.columns
      : // A rowset with no declared columns still has to produce a readable
        // sheet rather than an empty file, so the keys of the first row stand
        // in. This is the shape `POST /analytics/export` hands over for a
        // free-form aggregate.
        Object.keys(sheet.rows[0] ?? {}).map((key) => ({ key, label: key }));

    const headerRow = worksheet.addRow(columns.map((c) => c.label));
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF3F4F6' },
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
    });

    for (const row of sheet.rows) {
      worksheet.addRow(columns.map((c) => toCellValue(row[c.key])));
    }

    // Width from the widest value actually present, clamped. exceljs has no
    // auto-fit (the real thing needs font metrics), and every column at the
    // default width makes a timestamp column read as "######".
    columns.forEach((column, columnIndex) => {
      let widest = String(column.label).length;
      for (const row of sheet.rows) {
        const value = toCellValue(row[column.key]);
        const length =
          value instanceof Date ? 20 : value === null ? 0 : String(value).length;
        if (length > widest) widest = length;
        if (widest >= MAX_COLUMN_WIDTH) break;
      }
      worksheet.getColumn(columnIndex + 1).width = Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, widest + 2),
      );
    });

    if (columns.length > 0) {
      worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
      worksheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber, column: columns.length },
      };
    }
  });

  // writeBuffer() returns an ArrayBuffer-ish; Buffer.from normalises it so the
  // caller gets the same type the PDF and CSV branches return.
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
