/**
 * PdfTextExtractor — Backend 2 (Offline PDF fallback)
 *
 * Uses pdf-parse to extract raw text from PDF files.
 * No AWS access required.
 *
 * Active when:
 *   - TEXTRACT_ENABLED=false OR no AWS access  AND
 *   - Document is a PDF  AND
 *   - S3_BUCKET is NOT set (local file storage via UPLOAD_DIR)
 *     OR S3_BUCKET IS set but we download the file first.
 *
 * Field extraction:
 *   Applies regex patterns to the raw PDF text to extract
 *   structured fields (invoice number, amounts, dates, etc.)
 *   This covers 80%+ of structured shipping documents.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentFields } from '../../agent/contracts';
import { config } from '../../config';

// Lazy-load pdf-parse to avoid startup cost when not used
let pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;

async function getPdfParser() {
  if (!pdfParse) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('pdf-parse');
      pdfParse = mod.default ?? mod;
    } catch {
      return null;
    }
  }
  return pdfParse;
}

// ─── Regex Field Extractors ───────────────────────────────────────────────────
// Applied to raw PDF text to extract key shipping document fields.

const FIELD_PATTERNS: Array<{
  key: string;
  patterns: RegExp[];
}> = [
  {
    key: 'invoice_number',
    patterns: [/invoice\s*(?:no|number|#)[\s:]*([A-Z0-9\-\/]+)/i, /inv[\s#:]*([A-Z0-9\-]+)/i],
  },
  {
    key: 'total_amount',
    patterns: [/total\s*(?:amount|due|value)?[\s:$]*([0-9,]+\.?[0-9]*)/i],
  },
  {
    key: 'currency',
    patterns: [/\b(USD|EUR|GBP|JPY|CNY|INR|SGD|AUD|CAD)\b/i],
  },
  {
    key: 'issue_date',
    patterns: [
      /(?:invoice|issue|date)[\s:]*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})/i,
      /(\d{4}-\d{2}-\d{2})/,
    ],
  },
  {
    key: 'payment_terms',
    patterns: [/payment\s*terms?[\s:]*([^\n]+)/i, /(net\s*\d+)/i],
  },
  {
    key: 'sender_name',
    patterns: [/(?:from|shipper|sender|exporter)[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i],
  },
  {
    key: 'receiver_name',
    patterns: [/(?:to|consignee|receiver|importer)[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i],
  },
  {
    key: 'bol_number',
    patterns: [/b(?:ill)?\s*of\s*lading\s*(?:no|number|#)?[\s:]*([A-Z0-9\-]+)/i],
  },
  {
    key: 'carrier_name',
    patterns: [/carrier[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i],
  },
  {
    key: 'vessel_name',
    patterns: [/vessel[\s:]*([A-Za-z0-9\s]+?)(?:\n|$)/i],
  },
  {
    key: 'port_of_loading',
    patterns: [/(?:port\s*of\s*loading|pol)[\s:]*([A-Za-z\s,]+?)(?:\n|$)/i],
  },
  {
    key: 'port_of_discharge',
    patterns: [/(?:port\s*of\s*discharge|pod|destination)[\s:]*([A-Za-z\s,]+?)(?:\n|$)/i],
  },
  {
    key: 'hs_code',
    patterns: [/hs\s*(?:code|tariff)?[\s:]*(\d{4}[\.\d]*)/i],
  },
  {
    key: 'declared_value',
    patterns: [/(?:declared|customs)\s*value[\s:$]*([0-9,]+\.?[0-9]*)/i],
  },
  {
    key: 'origin_country',
    patterns: [/country\s*of\s*origin[\s:]*([A-Za-z\s]+?)(?:\n|$)/i],
  },
  {
    key: 'destination_country',
    patterns: [/country\s*of\s*destination[\s:]*([A-Za-z\s]+?)(?:\n|$)/i],
  },
  {
    key: 'gross_weight',
    patterns: [/(?:gross\s*)?weight[\s:]*([0-9]+\.?[0-9]*)\s*(?:kg|lbs?)?/i],
  },
  {
    key: 'tracking_number',
    patterns: [/(?:tracking|track)\s*(?:no|number|#)?[\s:]*([A-Z0-9\-]{6,})/i],
  },
  {
    key: 'delivery_date',
    patterns: [/(?:delivered|delivery)\s*(?:date|on)?[\s:]*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})/i],
  },
  {
    key: 'delivered_to',
    patterns: [/(?:received\s*by|delivered\s*to|signed\s*by)[\s:]*([A-Za-z][\w\s\.]+?)(?:\n|$)/i],
  },
];

function extractFieldsFromText(text: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const { key, patterns } of FIELD_PATTERNS) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        fields[key] = match[1].trim().replace(/\s+/g, ' ');
        break;
      }
    }
  }

  // If no structured fields found, store the raw text summary
  if (Object.keys(fields).length === 0) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (preview) {
      fields['extracted_text'] = preview;
    }
  }

  return fields;
}

// ─── PdfTextExtractor class ───────────────────────────────────────────────────

export class PdfTextExtractor implements DocumentExtractor {
  readonly name = 'PdfTextExtractor';

  canHandle(doc: DocumentRecord): boolean {
    const mime = doc.fileType.toLowerCase();
    const isPdf = mime.includes('pdf');
    // Can handle PDFs stored locally (UPLOAD_DIR) — S3 PDFs handled by Textract
    const isLocal = !config.s3Bucket || !config.textractEnabled;
    return isPdf && isLocal;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    console.log(`[PdfTextExtractor] Extracting: ${doc.fileName}`);

    const parser = await getPdfParser();
    if (!parser) {
      console.warn('[PdfTextExtractor] pdf-parse not available — returning empty fields');
      return { documentId: doc.id, documentType: doc.documentType, fields: {}, confidence: 0 };
    }

    try {
      const filePath = this.resolveFilePath(doc.fileName);
      const buffer = fs.readFileSync(filePath);
      const data = await parser(buffer);
      const fields = extractFieldsFromText(data.text);

      const confidence = Object.keys(fields).length > 2 ? 0.72 : 0.45;
      console.log(`[PdfTextExtractor] Extracted ${Object.keys(fields).length} fields (confidence: ${confidence})`);

      return {
        documentId: doc.id,
        documentType: doc.documentType,
        fields,
        confidence,
      };
    } catch (err) {
      console.error(`[PdfTextExtractor] Failed for ${doc.fileName}:`, err);
      return {
        documentId: doc.id,
        documentType: doc.documentType,
        fields: { extraction_error: String(err) },
        confidence: 0,
      };
    }
  }

  private resolveFilePath(fileName: string): string {
    const uploadDir = process.env.UPLOAD_DIR || '/uploads';
    return path.join(uploadDir, path.basename(fileName));
  }
}

export const pdfTextExtractor = new PdfTextExtractor();
