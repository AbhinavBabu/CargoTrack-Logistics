/**
 * PdfTextExtractor — Backend 2 (Offline PDF fallback)
 *
 * Uses pdf-parse to extract raw text from PDF files.
 * No AWS access required.
 *
 * v3.1 CHANGE: Returns ExtractedDocumentText (rawText) instead of
 * ExtractedDocumentFields (key-value map). The LLM reads the raw text
 * and applies its own reasoning — the extractor's job is purely
 * to get the text out of the file, not to interpret it.
 *
 * Active when:
 *   - TEXTRACT_ENABLED=false OR no AWS access  AND
 *   - Document is a PDF
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';
import { config } from '../../config';

// Lazy-load pdf-parse to avoid startup cost when not used
let pdfParse: ((buf: Buffer) => Promise<{ text: string; numpages: number }>) | null = null;

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

export class PdfTextExtractor implements DocumentExtractor {
  readonly name = 'PdfTextExtractor';

  canHandle(doc: DocumentRecord): boolean {
    const mime = doc.fileType.toLowerCase();
    const isPdf = mime.includes('pdf');
    // Can handle PDFs stored locally (UPLOAD_DIR) — S3 PDFs handled by Textract
    const isLocal = !config.s3Bucket || !config.textractEnabled;
    return isPdf && isLocal;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    console.log(`[PdfTextExtractor] Extracting: ${doc.fileName}`);

    const parser = await getPdfParser();
    if (!parser) {
      console.warn('[PdfTextExtractor] pdf-parse not available — returning empty text');
      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText: '',
        extractionMethod: 'pdf-parse',
        confidence: 0,
        pageCount: 0,
      };
    }

    try {
      const filePath = this.resolveFilePath(doc.fileName);
      const buffer = fs.readFileSync(filePath);
      const data = await parser(buffer);

      // Clean up the extracted text: normalize whitespace but preserve structure
      const rawText = data.text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')  // collapse 3+ blank lines to 2
        .trim();

      // Confidence based on text density: more text = better extraction
      const confidence = rawText.length > 200 ? 0.82 : rawText.length > 50 ? 0.65 : 0.35;

      console.log(`[PdfTextExtractor] Extracted ${rawText.length} chars from ${data.numpages} page(s), confidence: ${confidence}`);

      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText,
        extractionMethod: 'pdf-parse',
        confidence,
        pageCount: data.numpages,
      };
    } catch (err) {
      console.error(`[PdfTextExtractor] Failed for ${doc.fileName}:`, err);
      return {
        documentId: doc.id,
        documentType: doc.documentType,
        rawText: `[Extraction failed: ${String(err)}]`,
        extractionMethod: 'pdf-parse',
        confidence: 0,
        pageCount: 0,
      };
    }
  }

  private resolveFilePath(fileName: string): string {
    const uploadDir = process.env.UPLOAD_DIR || '/uploads';
    return path.join(uploadDir, path.basename(fileName));
  }
}

export const pdfTextExtractor = new PdfTextExtractor();
