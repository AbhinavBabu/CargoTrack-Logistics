import {
  TextractClient,
  AnalyzeDocumentCommand,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
  type Block,
  type FeatureType,
} from '@aws-sdk/client-textract';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { DocumentRecord, ExtractedDocumentText } from '../agent/contracts';
import { DocumentType } from '@prisma/client';

/**
 * @deprecated v3.0 type — kept for backward compat with legacy extractFields() methods.
 * The v3.1 architecture uses ExtractedDocumentText (rawText) instead.
 * All new code should call extractText() which returns ExtractedDocumentText.
 */
interface ExtractedDocumentFields {
  documentId: string;
  documentType: DocumentType;
  fields: Record<string, string>;
  confidence: number;
}

// ─── Textract Service ─────────────────────────────────────────────────────────
//
// Two code paths:
//   SYNC  — images (JPEG, PNG, TIFF) → AnalyzeDocument (real-time)
//   ASYNC — PDFs → StartDocumentAnalysis → poll GetDocumentAnalysis
//
// Both paths fall back to mock extraction when:
//   - MOCK_AGENT=true
//   - No AWS region configured
//   - S3_BUCKET not set (local file storage mode)
//
// Phase 3 integration point: tools.ts calls extractFields(doc)
//

const SYNC_MIME_TYPES = ['image/jpeg', 'image/png', 'image/tiff', 'image/webp'];
const ASYNC_MIME_TYPES = ['application/pdf'];
const ALL_SUPPORTED = [...SYNC_MIME_TYPES, ...ASYNC_MIME_TYPES];

// Max poll attempts for async Textract (30s × 20 = 10 min ceiling)
const MAX_POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 30_000;

// ─── Block Parsing ────────────────────────────────────────────────────────────
// Textract returns a flat list of Block objects with parent/child relationships.
// We extract KEY_VALUE_SET pairs and build a plain string→string map.

function parseTextractBlocks(blocks: Block[]): Record<string, string> {
  const kvPairs: Record<string, string> = {};

  // Index blocks by ID for O(1) child lookup
  const blockIndex = new Map<string, Block>(
    blocks.map((b) => [b.Id ?? '', b])
  );

  // KEY blocks have a child VALUE block via CHILD relationship
  const keyBlocks = blocks.filter(
    (b) => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes?.includes('KEY')
  );

  for (const keyBlock of keyBlocks) {
    const keyText = collectText(keyBlock, blockIndex);

    // Find the associated VALUE block
    const valueRelationship = keyBlock.Relationships?.find(
      (r) => r.Type === 'VALUE'
    );
    if (!valueRelationship?.Ids?.length) continue;

    const valueBlock = blockIndex.get(valueRelationship.Ids[0]);
    if (!valueBlock) continue;

    const valueText = collectText(valueBlock, blockIndex);
    if (keyText && valueText) {
      // Normalise key: lowercase, replace spaces/special chars with underscores
      const normKey = keyText.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      kvPairs[normKey] = valueText.trim();
    }
  }

  // Also collect raw LINE text as a fallback if no K-V pairs found
  if (Object.keys(kvPairs).length === 0) {
    const lines = blocks
      .filter((b) => b.BlockType === 'LINE')
      .map((b) => b.Text ?? '')
      .filter(Boolean);
    if (lines.length > 0) {
      kvPairs['extracted_text'] = lines.join(' | ');
    }
  }

  return kvPairs;
}

/**
 * Concatenate Textract LINE blocks into human-readable text.
 * This is the v3.1 output format — raw text for LLM analysis.
 */
function blocksToRawText(blocks: Block[]): string {
  return blocks
    .filter((b) => b.BlockType === 'LINE')
    .map((b) => b.Text ?? '')
    .filter(Boolean)
    .join('\n');
}

function collectText(block: Block, index: Map<string, Block>): string {
  const childRelationship = block.Relationships?.find((r) => r.Type === 'CHILD');
  if (!childRelationship?.Ids) return block.Text ?? '';

  return childRelationship.Ids
    .map((id) => index.get(id))
    .filter((b): b is Block => b?.BlockType === 'WORD')
    .map((b) => b.Text ?? '')
    .join(' ');
}

// ─── Average confidence from blocks ──────────────────────────────────────────

function averageConfidence(blocks: Block[]): number {
  const confidences = blocks
    .filter((b) => b.Confidence !== undefined)
    .map((b) => b.Confidence! / 100);

  if (confidences.length === 0) return 0.5;
  return confidences.reduce((a, b) => a + b, 0) / confidences.length;
}

// ─── Mock field data (used when AWS not configured) ──────────────────────────

const MOCK_FIELDS: Record<DocumentType, Record<string, string>> = {
  INVOICE: {
    invoice_number: `INV-${Date.now()}`,
    sender_name: 'Mock Sender Corp',
    receiver_name: 'Mock Receiver Ltd',
    total_amount: '1500.00',
    currency: 'USD',
    issue_date: new Date().toISOString().split('T')[0],
    payment_terms: 'Net 30',
  },
  CUSTOMS: {
    hs_code: '8471.30.00',
    declared_value: '1500.00',
    origin_country: 'US',
    destination_country: 'DE',
    goods_description: 'Electronic equipment — laptops',
    number_of_packages: '1',
    gross_weight: '5.2',
  },
  BILL_OF_LADING: {
    bol_number: `BOL-${Date.now()}`,
    carrier_name: 'Mock Shipping Lines',
    vessel_name: 'MV CargoTrack Express',
    port_of_loading: 'New York, USA',
    port_of_discharge: 'Hamburg, Germany',
    shipper: 'Mock Sender Corp',
    consignee: 'Mock Receiver Ltd',
  },
  SHIPPING_LABEL: {
    tracking_number: `TRK-${Date.now()}`,
    service_type: 'EXPRESS',
    weight: '5.2',
    dimensions: '30x20x15 cm',
    sender_address: '123 Sender St, New York, NY',
    receiver_address: '456 Receiver Ave, Hamburg, DE',
  },
  SHIPPING_MANIFEST: {
    manifest_number: `MAN-${Date.now()}`,
    total_packages: '1',
    total_weight: '5.2',
    special_handling: 'HANDLE WITH CARE',
    hazmat: 'NO',
    temperature_sensitive: 'NO',
  },
  PROOF_OF_DELIVERY: {
    delivery_date: new Date().toISOString().split('T')[0],
    delivered_to: 'Mock Receiver',
    signature_name: 'J. Smith',
    signature_obtained: 'YES',
    delivery_location: '456 Receiver Ave, Hamburg',
    delivery_notes: 'Received in good condition',
  },
  OTHER: {
    document_type: 'UNCLASSIFIED',
    content_summary: 'Unrecognized document format',
  },
};

// ─── Main Textract Service Class ──────────────────────────────────────────────

export class TextractService {
  private textract: TextractClient | null = null;
  private s3: S3Client | null = null;
  private bucket: string;
  private isMock: boolean;

  constructor() {
    this.bucket = config.s3Bucket;
    this.isMock = config.mockAgent || !config.region || !this.bucket;

    if (!this.isMock) {
      this.textract = new TextractClient({ region: config.region });
      this.s3 = new S3Client({ region: config.region });
      console.log(`[textract] Initialized — bucket: ${this.bucket}, region: ${config.region}`);
    } else {
      console.log('[textract] Mock mode — returning synthetic field data');
    }
  }

  /**
   * v3.1: Extract raw text from a document for LLM analysis.
   * Returns full readable text by concatenating Textract LINE blocks.
   * Falls back to mock text if AWS is not configured.
   */
  async extractText(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    if (this.isMock || !this.textract) {
      return this.mockExtractText(doc);
    }

    const mimeType = doc.fileType.toLowerCase();

    if (!ALL_SUPPORTED.some((m) => mimeType.includes(m.split('/')[1]))) {
      console.warn(`[textract] Unsupported MIME type: ${mimeType} — using mock text`);
      return this.mockExtractText(doc);
    }

    try {
      if (SYNC_MIME_TYPES.some((m) => mimeType.includes(m.split('/')[1]))) {
        return await this.syncExtractText(doc);
      } else {
        return await this.asyncExtractText(doc);
      }
    } catch (err) {
      console.error(`[textract] Text extraction failed for doc ${doc.id} — falling back to mock:`, err);
      return this.mockExtractText(doc);
    }
  }

  /**
   * @deprecated Use extractText() for v3.1 LLM-driven compliance.
   * Kept for backward compatibility only.
   */
  async extractFields(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    if (this.isMock || !this.textract) {
      return this.mockExtract(doc);
    }

    const mimeType = doc.fileType.toLowerCase();

    if (!ALL_SUPPORTED.some((m) => mimeType.includes(m.split('/')[1]))) {
      console.warn(`[textract] Unsupported MIME type: ${mimeType} — using mock`);
      return this.mockExtract(doc);
    }

    try {
      if (SYNC_MIME_TYPES.some((m) => mimeType.includes(m.split('/')[1]))) {
        return await this.syncExtract(doc);
      } else {
        return await this.asyncExtract(doc);
      }
    } catch (err) {
      console.error(`[textract] Extraction failed for doc ${doc.id} — falling back to mock:`, err);
      return this.mockExtract(doc);
    }
  }

  // ── Synchronous extraction (images) — raw text output ─────────────────────

  private async syncExtractText(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    console.log(`[textract][SYNC] Analyzing for text: ${doc.fileName}`);

    const command = new AnalyzeDocumentCommand({
      Document: {
        S3Object: {
          Bucket: this.bucket,
          Name: doc.fileName,
        },
      },
      FeatureTypes: ['FORMS' as FeatureType, 'TABLES' as FeatureType],
    });

    const response = await this.textract!.send(command);
    const blocks = response.Blocks ?? [];

    const rawText = blocksToRawText(blocks);
    const confidence = averageConfidence(blocks);

    console.log(`[textract][SYNC] Extracted ${rawText.length} chars, confidence: ${confidence.toFixed(2)}`);

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      rawText,
      extractionMethod: 'textract',
      confidence,
      pageCount: 1,
    };
  }

  // ── Synchronous extraction (images) — key-value fields output (deprecated) ─

  private async syncExtract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    console.log(`[textract][SYNC] Analyzing: ${doc.fileName}`);

    const command = new AnalyzeDocumentCommand({
      Document: {
        S3Object: {
          Bucket: this.bucket,
          Name: doc.fileName,
        },
      },
      FeatureTypes: ['FORMS' as FeatureType, 'TABLES' as FeatureType],
    });

    const response = await this.textract!.send(command);
    const blocks = response.Blocks ?? [];

    const fields = parseTextractBlocks(blocks);
    const confidence = averageConfidence(blocks);

    console.log(`[textract][SYNC] Extracted ${Object.keys(fields).length} fields, confidence: ${confidence.toFixed(2)}`);

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      fields,
      confidence,
    };
  }

  // ── Asynchronous extraction (PDFs) — raw text output ──────────────────────

  private async asyncExtractText(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    console.log(`[textract][ASYNC] Starting text analysis: ${doc.fileName}`);

    const startCommand = new StartDocumentAnalysisCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: this.bucket,
          Name: doc.fileName,
        },
      },
      FeatureTypes: ['FORMS' as FeatureType, 'TABLES' as FeatureType],
    });

    const startResponse = await this.textract!.send(startCommand);
    const jobId = startResponse.JobId;
    if (!jobId) throw new Error('Textract async job started but returned no JobId');

    console.log(`[textract][ASYNC] JobId: ${jobId} — polling...`);

    const allBlocks: Block[] = [];
    let attempts = 0;
    let pageCount = 1;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      await sleep(POLL_INTERVAL_MS);

      const getCommand = new GetDocumentAnalysisCommand({ JobId: jobId });
      const result = await this.textract!.send(getCommand);

      if (result.JobStatus === 'FAILED') {
        throw new Error(`Textract async job failed: ${result.StatusMessage}`);
      }

      if (result.JobStatus === 'SUCCEEDED') {
        allBlocks.push(...(result.Blocks ?? []));
        let nextToken = result.NextToken;
        while (nextToken) {
          const pageResult = await this.textract!.send(
            new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: nextToken })
          );
          allBlocks.push(...(pageResult.Blocks ?? []));
          nextToken = pageResult.NextToken;
        }
        // Count unique page numbers
        const pageNums = new Set(allBlocks.map((b) => b.Page ?? 1));
        pageCount = pageNums.size;

        const rawText = blocksToRawText(allBlocks);
        const confidence = averageConfidence(allBlocks);

        console.log(`[textract][ASYNC] Complete — ${rawText.length} chars, ${pageCount} page(s), confidence: ${confidence.toFixed(2)}`);

        return {
          documentId: doc.id,
          documentType: doc.documentType,
          rawText,
          extractionMethod: 'textract',
          confidence,
          pageCount,
        };
      }

      console.log(`[textract][ASYNC] Job ${jobId} status: ${result.JobStatus} (attempt ${attempts}/${MAX_POLL_ATTEMPTS})`);
    }

    throw new Error(`Textract async job ${jobId} timed out after ${MAX_POLL_ATTEMPTS} poll attempts`);
  }

  // ── Asynchronous extraction (PDFs) — key-value fields output (deprecated) ──

  private async asyncExtract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    console.log(`[textract][ASYNC] Starting analysis: ${doc.fileName}`);

    // Start the job
    const startCommand = new StartDocumentAnalysisCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: this.bucket,
          Name: doc.fileName,
        },
      },
      FeatureTypes: ['FORMS' as FeatureType, 'TABLES' as FeatureType],
    });

    const startResponse = await this.textract!.send(startCommand);
    const jobId = startResponse.JobId;

    if (!jobId) {
      throw new Error('Textract async job started but returned no JobId');
    }

    console.log(`[textract][ASYNC] JobId: ${jobId} — polling for results...`);

    // Poll until complete
    const allBlocks: Block[] = [];
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      await sleep(POLL_INTERVAL_MS);

      const getCommand = new GetDocumentAnalysisCommand({ JobId: jobId });
      const result = await this.textract!.send(getCommand);

      if (result.JobStatus === 'FAILED') {
        throw new Error(`Textract async job failed: ${result.StatusMessage}`);
      }

      if (result.JobStatus === 'SUCCEEDED') {
        allBlocks.push(...(result.Blocks ?? []));

        // Handle pagination for multi-page PDFs
        let nextToken = result.NextToken;
        while (nextToken) {
          const pageResult = await this.textract!.send(
            new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: nextToken })
          );
          allBlocks.push(...(pageResult.Blocks ?? []));
          nextToken = pageResult.NextToken;
        }

        const fields = parseTextractBlocks(allBlocks);
        const confidence = averageConfidence(allBlocks);

        console.log(`[textract][ASYNC] Complete — ${Object.keys(fields).length} fields, confidence: ${confidence.toFixed(2)}`);

        return {
          documentId: doc.id,
          documentType: doc.documentType,
          fields,
          confidence,
        };
      }

      console.log(`[textract][ASYNC] Job ${jobId} status: ${result.JobStatus} (attempt ${attempts}/${MAX_POLL_ATTEMPTS})`);
    }

    throw new Error(`Textract async job ${jobId} timed out after ${MAX_POLL_ATTEMPTS} poll attempts`);
  }

  // ── Mock text extraction (v3.1) ─────────────────────────────────────────────

  private mockExtractText(doc: DocumentRecord): ExtractedDocumentText {
    console.log(`[textract][MOCK] Returning mock document text for ${doc.documentType} (doc: ${doc.id})`);
    // Produce inline mock text consistent with the mock extractor
    const mockTexts: Record<string, string> = {
      INVOICE: `COMMERCIAL INVOICE\nInvoice Number: INV-MOCK-${Date.now()}\nSeller: Mock Sender Corp\nBuyer: Mock Receiver Ltd\nTotal: USD 1,500.00\nGoods: Electronic equipment`,
      CUSTOMS: `CUSTOMS DECLARATION\nHS Code: 8471.30.00\nDeclared Value: USD 1,500.00\nOrigin: United States\nDestination: Germany\nGoods: Electronic equipment`,
      BILL_OF_LADING: `BILL OF LADING\nB/L No: BOL-MOCK-${Date.now()}\nCarrier: Mock Shipping Lines\nVessel: MV CargoTrack Express\nPort of Loading: New York, USA\nPort of Discharge: Hamburg, Germany\nGross Weight: 5.2 KG`,
      SHIPPING_LABEL: `SHIPPING LABEL\nTracking: TRK-MOCK-${Date.now()}\nService: EXPRESS\nWeight: 5.2 KG\nFrom: Mock Sender Corp, New York, NY\nTo: Mock Receiver Ltd, Hamburg, DE`,
      SHIPPING_MANIFEST: `SHIPPING MANIFEST\nManifest No: MAN-MOCK-${Date.now()}\nTotal Packages: 1\nTotal Weight: 5.2 KG\nHazmat: NO`,
      PROOF_OF_DELIVERY: `PROOF OF DELIVERY\nDelivery Date: ${new Date().toISOString().split('T')[0]}\nDelivered To: Mock Receiver\nSignature: J. Smith\nCondition: Good`,
    };
    return {
      documentId: doc.id,
      documentType: doc.documentType,
      rawText: mockTexts[doc.documentType] ?? `UNCLASSIFIED DOCUMENT\nContent requires manual review.`,
      extractionMethod: 'mock',
      confidence: 0.92,
      pageCount: 1,
    };
  }

  // ── Mock key-value extraction (deprecated) ─────────────────────────────────

  private mockExtract(doc: DocumentRecord): ExtractedDocumentFields {
    const fields = { ...(MOCK_FIELDS[doc.documentType] ?? MOCK_FIELDS.OTHER) };
    // Add some realistic timestamp noise so each mock run is distinct
    if (fields.invoice_number) fields.invoice_number = `INV-${Date.now()}`;
    if (fields.bol_number) fields.bol_number = `BOL-${Date.now()}`;
    if (fields.tracking_number) fields.tracking_number = `TRK-${Date.now()}`;

    console.log(`[textract][MOCK] Returning synthetic fields for ${doc.documentType} (doc: ${doc.id})`);

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      fields,
      confidence: 0.92,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton — shared by agent tools
export const textractService = new TextractService();
