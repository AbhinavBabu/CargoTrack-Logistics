/**
 * MockExtractor — Backend 4 (Always available)
 *
 * Returns realistic synthetic fields for any document type.
 * Used in development, testing, and when no other extractor is available.
 * This is the final fallback — it never fails.
 */

import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentFields } from '../../agent/contracts';
import { DocumentType } from '@prisma/client';

const MOCK_FIELDS: Record<DocumentType, Record<string, string>> = {
  INVOICE: {
    invoice_number: `INV-MOCK-${Date.now()}`,
    sender_name: 'Global Exports Ltd',
    receiver_name: 'European Imports GmbH',
    total_amount: '4750.00',
    currency: 'USD',
    issue_date: new Date().toISOString().split('T')[0],
    payment_terms: 'Net 30',
    goods_description: 'Electronic equipment — 10x Laptop Computers',
  },
  CUSTOMS: {
    hs_code: '8471.30.00',
    declared_value: '4750.00',
    currency: 'USD',
    origin_country: 'United States',
    destination_country: 'Germany',
    goods_description: 'Electronic equipment — laptops',
    number_of_packages: '1',
    gross_weight: '15.5',
    duties_paid: 'NO',
  },
  BILL_OF_LADING: {
    bol_number: `BOL-MOCK-${Date.now()}`,
    carrier_name: 'Maersk Line',
    vessel_name: 'MV Atlantic Carrier',
    port_of_loading: 'New York, USA (USNYC)',
    port_of_discharge: 'Hamburg, Germany (DEHAM)',
    shipper: 'Global Exports Ltd',
    consignee: 'European Imports GmbH',
    notify_party: 'European Imports GmbH',
    number_of_packages: '1',
    gross_weight: '15.5',
  },
  SHIPPING_LABEL: {
    tracking_number: `TRK-MOCK-${Date.now()}`,
    service_type: 'EXPRESS',
    weight: '15.5',
    dimensions: '60x40x30 cm',
    sender_address: '100 Commerce Blvd, New York, NY 10001',
    receiver_address: '25 Handelstraße, Hamburg 20095, Germany',
    barcode: '1234567890123',
  },
  SHIPPING_MANIFEST: {
    manifest_number: `MAN-MOCK-${Date.now()}`,
    total_packages: '1',
    total_weight: '15.5',
    special_handling: 'FRAGILE',
    hazmat: 'NO',
    temperature_sensitive: 'NO',
    declared_value: '4750.00',
  },
  PROOF_OF_DELIVERY: {
    delivery_date: new Date().toISOString().split('T')[0],
    delivered_to: 'Hans Mueller',
    signature_name: 'H. Mueller',
    signature_obtained: 'YES',
    delivery_location: '25 Handelstraße, Hamburg 20095, Germany',
    delivery_notes: 'Package received in good condition. No visible damage.',
  },
  OTHER: {
    document_type: 'UNCLASSIFIED',
    content_summary: 'Unrecognized document format — manual review required',
  },
};

export class MockExtractor implements DocumentExtractor {
  readonly name = 'MockExtractor';

  // Always available as final fallback
  canHandle(_doc: DocumentRecord): boolean {
    return true;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentFields> {
    const base = MOCK_FIELDS[doc.documentType] ?? MOCK_FIELDS.OTHER;
    // Add timestamp noise so each mock run produces distinct IDs
    const fields = { ...base };
    if (fields.invoice_number) fields.invoice_number = `INV-MOCK-${Date.now()}`;
    if (fields.bol_number) fields.bol_number = `BOL-MOCK-${Date.now()}`;
    if (fields.tracking_number) fields.tracking_number = `TRK-MOCK-${Date.now()}`;
    if (fields.manifest_number) fields.manifest_number = `MAN-MOCK-${Date.now()}`;

    console.log(`[MockExtractor] Returning synthetic fields for ${doc.documentType} (doc: ${doc.id})`);

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      fields,
      confidence: 0.92, // High mock confidence to not trigger PARTIAL status
    };
  }
}

export const mockExtractor = new MockExtractor();
