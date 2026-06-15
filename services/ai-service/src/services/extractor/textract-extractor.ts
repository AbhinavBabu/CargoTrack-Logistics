/**
 * TextractExtractor — Backend 1 (Primary)
 *
 * Wraps the existing TextractService and adapts it to DocumentExtractor.
 * Active when:
 *   - TEXTRACT_ENABLED=true  AND
 *   - AWS_DEFAULT_REGION is set  AND
 *   - S3_BUCKET is set  AND
 *   - MOCK_AGENT != true
 */

import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentFields } from '../../agent/contracts';
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

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    console.log(`[TextractExtractor] Extracting: ${doc.fileName}`);
    return textractService.extractFields(doc);
  }
}

export const textractExtractor = new TextractExtractor();
