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
 *   4. MockExtractor      — realistic document text (always works)
 *
 * v3.1 CHANGE: extract() now returns ExtractedDocumentText (raw text)
 * instead of ExtractedDocumentFields (key-value map).
 * The intelligence is in the LLM reasoning, not in the extractor parsing.
 */

import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';

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
   * Extract raw text content from the document.
   * Returns full readable text suitable for LLM analysis.
   * Must never throw — return empty rawText with confidence=0 on failure.
   */
  extract(doc: DocumentRecord): Promise<ExtractedDocumentText>;
}
