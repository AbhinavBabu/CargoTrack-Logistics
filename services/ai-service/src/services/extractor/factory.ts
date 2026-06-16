/**
 * DocumentExtractor Factory
 *
 * Selects the appropriate extraction backend at runtime based on:
 *   1. Document file type (PDF vs image)
 *   2. Environment configuration (TEXTRACT_ENABLED, MOCK_AGENT, AWS creds)
 *   3. Library availability (pdf-parse, tesseract.js)
 *
 * v3.1: Returns ExtractedDocumentText (raw text) — not ExtractedDocumentFields.
 * The LLM reads the raw text and reasons over it directly.
 *
 * Selection order (first canHandle() winner wins):
 *   TextractExtractor  → Requires: TEXTRACT_ENABLED=true + AWS creds + S3_BUCKET
 *   PdfTextExtractor   → Requires: PDF + pdf-parse installed
 *   OcrExtractor       → Requires: Image + tesseract.js installed
 *   MockExtractor      → Always available (final fallback)
 *
 * Usage:
 *   const result = await extractorFactory.extract(doc);
 *   // result.rawText → hand to LLM for analysis
 */

import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';
import { textractExtractor } from './textract-extractor';
import { pdfTextExtractor } from './pdf-extractor';
import { ocrExtractor } from './ocr-extractor';
import { mockExtractor } from './mock-extractor';

// Ordered list — first extractor whose canHandle() returns true is used
const EXTRACTORS: DocumentExtractor[] = [
  textractExtractor,
  pdfTextExtractor,
  ocrExtractor,
  mockExtractor,
];

class DocumentExtractorFactory {
  /**
   * Select the best available extractor for the given document.
   * Logs the selected backend name for audit trail.
   */
  select(doc: DocumentRecord): DocumentExtractor {
    for (const extractor of EXTRACTORS) {
      if (extractor.canHandle(doc)) {
        console.log(`[ExtractorFactory] Selected: ${extractor.name} for ${doc.documentType} (${doc.fileType})`);
        return extractor;
      }
    }
    // This should never happen since MockExtractor always returns true
    console.warn('[ExtractorFactory] No extractor matched — using MockExtractor as safety fallback');
    return mockExtractor;
  }

  /**
   * Convenience method: select + extract in one call.
   * Returns raw document text for LLM analysis.
   */
  async extract(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    const extractor = this.select(doc);
    return extractor.extract(doc);
  }

  /**
   * Returns the list of available extractors and their readiness.
   * Used by the /api/health endpoint to report extraction capabilities.
   */
  status(doc?: DocumentRecord): Array<{ name: string; available: boolean }> {
    const sampleDoc: DocumentRecord = doc ?? {
      id: 'test',
      originalName: 'test.pdf',
      fileName: 'test.pdf',
      documentType: 'INVOICE' as any,
      fileType: 'application/pdf',
      fileSize: 0,
      uploadedAt: new Date(),
    };
    return EXTRACTORS.map((e) => ({
      name: e.name,
      available: e.canHandle(sampleDoc),
    }));
  }
}

export const extractorFactory = new DocumentExtractorFactory();
