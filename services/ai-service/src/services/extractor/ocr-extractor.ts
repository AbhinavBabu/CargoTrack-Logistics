/**
 * OcrExtractor — Backend 3 (Offline image fallback)
 *
 * Uses tesseract.js (pure JavaScript OCR engine) to extract text from images.
 * No AWS access required. Works with JPEG, PNG, TIFF, WEBP.
 *
 * Active when:
 *   - TEXTRACT_ENABLED=false OR no AWS access  AND
 *   - Document is an image  AND
 *   - Tesseract.js is installed
 *
 * Note: OCR accuracy depends heavily on image quality.
 * Confidence is calculated from tesseract's own confidence scores.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentFields } from '../../agent/contracts';
import { config } from '../../config';

const SUPPORTED_IMAGE_TYPES = ['jpeg', 'jpg', 'png', 'tiff', 'tif', 'webp', 'bmp'];

// Lazy-load tesseract to avoid startup cost when not used
type TesseractWorker = {
  recognize: (img: string | Buffer) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<void>;
};

async function createWorker(): Promise<TesseractWorker | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Tesseract = require('tesseract.js');
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: () => {}, // suppress progress logs
    });
    return worker;
  } catch {
    return null;
  }
}

// Reuse regex patterns from PdfTextExtractor for consistency
const FIELD_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'invoice_number', patterns: [/invoice\s*(?:no|number|#)[\s:]*([A-Z0-9\-\/]+)/i] },
  { key: 'total_amount', patterns: [/total\s*(?:amount|due)?[\s:$]*([0-9,]+\.?[0-9]*)/i] },
  { key: 'currency', patterns: [/\b(USD|EUR|GBP|JPY|CNY|INR|SGD|AUD|CAD)\b/i] },
  { key: 'issue_date', patterns: [/(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})/, /(\d{4}-\d{2}-\d{2})/] },
  { key: 'sender_name', patterns: [/(?:from|shipper|sender)[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i] },
  { key: 'receiver_name', patterns: [/(?:to|consignee|receiver)[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i] },
  { key: 'tracking_number', patterns: [/(?:tracking|track)\s*(?:no|#)?[\s:]*([A-Z0-9\-]{6,})/i] },
  { key: 'gross_weight', patterns: [/(?:gross\s*)?weight[\s:]*([0-9]+\.?[0-9]*)\s*(?:kg|lbs?)?/i] },
  { key: 'carrier_name', patterns: [/carrier[\s:]*([A-Za-z][\w\s,\.]+?)(?:\n|$)/i] },
  { key: 'delivery_date', patterns: [/(?:delivered|delivery)\s*(?:date|on)?[\s:]*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})/i] },
];

function extractFromOcrText(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const { key, patterns } of FIELD_PATTERNS) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m?.[1]) { fields[key] = m[1].trim(); break; }
    }
  }
  if (Object.keys(fields).length === 0) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (preview) fields['extracted_text'] = preview;
  }
  return fields;
}

export class OcrExtractor implements DocumentExtractor {
  readonly name = 'OcrExtractor';

  canHandle(doc: DocumentRecord): boolean {
    const mime = doc.fileType.toLowerCase();
    const isImage = SUPPORTED_IMAGE_TYPES.some((t) => mime.includes(t));
    // Only activate when Textract is not available
    const textractUnavailable = !config.textractEnabled || config.mockAgent || !config.region;
    return isImage && textractUnavailable;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    console.log(`[OcrExtractor] Processing image: ${doc.fileName}`);

    const worker = await createWorker();
    if (!worker) {
      console.warn('[OcrExtractor] tesseract.js not available — returning empty fields');
      return { documentId: doc.id, documentType: doc.documentType, fields: {}, confidence: 0 };
    }

    try {
      const filePath = this.resolveFilePath(doc.fileName);
      const result = await worker.recognize(filePath);
      await worker.terminate();

      const { text, confidence: tesseractConfidence } = result.data;
      const fields = extractFromOcrText(text);

      // Tesseract confidence is 0-100; normalize to 0-1
      const confidence = Math.min(tesseractConfidence / 100, 1.0);

      console.log(`[OcrExtractor] Extracted ${Object.keys(fields).length} fields, OCR confidence: ${confidence.toFixed(2)}`);

      return {
        documentId: doc.id,
        documentType: doc.documentType,
        fields,
        confidence,
      };
    } catch (err) {
      console.error(`[OcrExtractor] Failed for ${doc.fileName}:`, err);
      try { await worker.terminate(); } catch { /* ignore */ }
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

export const ocrExtractor = new OcrExtractor();
