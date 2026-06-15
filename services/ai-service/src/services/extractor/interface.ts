/**
 * DocumentExtractor Interface
 *
 * All extraction backends implement this contract.
 * The selection strategy in factory.ts picks the right implementation
 * based on runtime config and document type — no changes needed in
 * agent tools.ts or runner.ts when backends are swapped.
 *
 * Extraction hierarchy:
 *   1. TextractExtractor  — AWS Textract (requires S3 + Textract access)
 *   2. PdfTextExtractor   — pdf-parse (works offline, PDFs only)
 *   3. OcrExtractor       — tesseract.js (works offline, images only)
 *   4. MockExtractor      — synthetic data (always works, for dev/test)
 */

import { DocumentRecord, ExtractedDocumentFields } from '../../agent/contracts';

export interface DocumentExtractor {
  /**
   * Human-readable name for logging.
   */
  readonly name: string;

  /**
   * Returns true if this extractor can handle the given document
   * given the current runtime environment.
   */
  canHandle(doc: DocumentRecord): boolean;

  /**
   * Extract structured fields from the document.
   * Must never throw — return empty fields with confidence=0 on unrecoverable failure.
   */
  extract(doc: DocumentRecord): Promise<ExtractedDocumentFields>;
}
