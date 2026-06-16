/**
 * OcrExtractor — Backend 3 (Offline image fallback)
 *
 * Uses tesseract.js (pure JavaScript OCR engine) to extract text from images.
 * No AWS access required. Works with JPEG, PNG, TIFF, WEBP.
 *
 * v3.1 CHANGE: Returns ExtractedDocumentText (rawText) instead of
 * ExtractedDocumentFields (key-value map). The raw OCR output goes
 * directly to the LLM for analysis — no regex field extraction.
 *
 * Note: OCR accuracy depends heavily on image quality.
 * Confidence is sourced from tesseract's own confidence scores.
 */

import * as path from 'path';
import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';
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

export class OcrExtractor implements DocumentExtractor {
  readonly name = 'OcrExtractor';

  canHandle(doc: DocumentRecord): boolean {
    const mime = doc.fileType.toLowerCase();
    const isImage = SUPPORTED_IMAGE_TYPES.some((t) => mime.includes(t));
    // Only activate when Textract is not available
    const textractUnavailable = !config.textractEnabled || config.mockAgent || !config.region;
    return isImage && textractUnavailable;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    console.log(`[OcrExtractor] Processing image: ${doc.fileName}`);

    const worker = await createWorker();
    if (!worker) {
      console.warn('[OcrExtractor] tesseract.js not available — returning empty text');
      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText: '',
        extractionMethod: 'tesseract',
        confidence: 0,
      };
    }

    try {
      const filePath = this.resolveFilePath(doc.fileName);
      const result = await worker.recognize(filePath);
      await worker.terminate();

      const { text, confidence: tesseractConfidence } = result.data;

      // Clean up OCR text
      const rawText = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Tesseract confidence is 0-100; normalize to 0-1
      const confidence = Math.min(tesseractConfidence / 100, 1.0);

      console.log(`[OcrExtractor] Extracted ${rawText.length} chars, OCR confidence: ${confidence.toFixed(2)}`);

      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText,
        extractionMethod: 'tesseract',
        confidence,
      };
    } catch (err) {
      console.error(`[OcrExtractor] Failed for ${doc.fileName}:`, err);
      try {
        const w = await createWorker();
        if (w) await w.terminate();
      } catch { /* ignore */ }
      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText: `[OCR extraction failed: ${String(err)}]`,
        extractionMethod: 'tesseract',
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
