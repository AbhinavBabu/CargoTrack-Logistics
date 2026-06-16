/**
 * TextractExtractor — Backend 1 (Primary)
 *
 * Wraps the TextractService and adapts it to DocumentExtractor.
 *
 * v3.1 CHANGE: Returns ExtractedDocumentText (rawText) instead of
 * ExtractedDocumentFields (key-value map). Textract's LINE blocks are
 * concatenated into full readable text for LLM analysis.
 *
 * Active when:
 *   - TEXTRACT_ENABLED=true  AND
 *   - AWS_DEFAULT_REGION is set  AND
 *   - S3_BUCKET is set  AND
 *   - MOCK_AGENT != true
 */

import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';
import { textractService } from '../textract';
import { config } from '../../config';

const SUPPORTED_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/tiff', 'image/webp',
  'application/pdf',
];

export class TextractExtractor implements DocumentExtractor {
  readonly name = 'TextractExtractor';

  canHandle(doc: DocumentRecord): boolean {
    if (!config.textractEnabled) return false;
    if (config.mockAgent) return false;
    if (!config.region || !config.s3Bucket) return false;

    const mime = doc.fileType.toLowerCase();
    return SUPPORTED_TYPES.some((t) => mime.includes(t.split('/')[1]));
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    console.log(`[TextractExtractor] Extracting text: ${doc.fileName}`);
    return textractService.extractText(doc);
  }
}

export const textractExtractor = new TextractExtractor();
