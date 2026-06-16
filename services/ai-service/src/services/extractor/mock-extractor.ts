/**
 * MockExtractor — Backend 4 (Always available)
 *
 * Returns realistic multi-paragraph shipping document text for each
 * document type. Designed so the LLM can read and reason over the text
 * as if it were a real document.
 *
 * v3.1 CHANGE: Returns ExtractedDocumentText (rawText) instead of
 * ExtractedDocumentFields (key-value map). The mock text is structured
 * like real shipping documents — formatted, labeled sections — so Nova
 * can perform genuine cross-document analysis.
 *
 * Used in development, testing, and when no other extractor is available.
 * This is the final fallback — it never fails.
 */

import { DocumentExtractor } from './interface';
import { DocumentRecord, ExtractedDocumentText } from '../../agent/contracts';
import { DocumentType } from '@prisma/client';

// Realistic shipping document templates — structured like actual documents
// so the LLM can read them naturally and cross-reference between documents.
// Uses consistent values across document types to enable cross-document analysis.

const MOCK_DOCUMENT_TEXT: Record<DocumentType, () => string> = {
  INVOICE: () => {
    const invNum = `INV-2026-${Math.floor(Math.random() * 9000) + 1000}`;
    const date = new Date().toISOString().split('T')[0];
    return `COMMERCIAL INVOICE

Invoice Number: ${invNum}
Invoice Date: ${date}
Payment Terms: Net 30 days
Currency: USD

SELLER / EXPORTER:
Global Exports Ltd
100 Commerce Boulevard, Suite 400
New York, NY 10001, United States
Tel: +1 (212) 555-0142
Tax ID: US-87654321

BUYER / CONSIGNEE:
European Imports GmbH
25 Handelstraße
Hamburg, 20095, Germany
Tel: +49 40 555 0876
VAT ID: DE-123456789

SHIP TO:
European Imports GmbH — Warehouse B
Hamburg Port, Dock 14
Hamburg, 20097, Germany

SHIPMENT DETAILS:
Carrier: Maersk Line
Vessel: MV Atlantic Carrier
Port of Loading: New York, USA (USNYC)
Port of Discharge: Hamburg, Germany (DEHAM)
Country of Origin: United States
Country of Destination: Germany

LINE ITEMS:
1. Laptop Computers, Model ProBook 450 G9    Qty: 10    Unit Price: USD 850.00    Total: USD 8,500.00
   HS Code: 8471.30.00 — Portable automatic data processing machines
2. Carrying Cases                             Qty: 10    Unit Price: USD 45.00     Total: USD 450.00
   HS Code: 4202.12.00 — Cases for laptop computers

SUBTOTAL: USD 8,950.00
Freight: USD 320.00
Insurance: USD 89.50
TOTAL INVOICE VALUE: USD 9,359.50

DECLARATION: I hereby certify that the information on this invoice is true, correct and complete.
Authorized Signature: _______________________
Name: James Mitchell, Export Manager
Date: ${date}`;
  },

  CUSTOMS: () => {
    const date = new Date().toISOString().split('T')[0];
    return `CUSTOMS DECLARATION FORM
EX-1 Export Declaration

Reference Number: EXP-US-2026-${Math.floor(Math.random() * 9000) + 1000}
Declaration Date: ${date}
Export Authority: US Customs and Border Protection

EXPORTER:
Global Exports Ltd, 100 Commerce Blvd, New York, NY 10001, USA
EORI Number: US-EXP-87654321

CONSIGNEE:
European Imports GmbH, 25 Handelstraße, Hamburg 20095, Germany

GOODS DESCRIPTION:
10x Laptop computers (portable automatic data processing machines)
and 10x laptop carrying cases

HS TARIFF CODE: 8471.30.00
GOODS CLASSIFICATION: Portable automatic data processing machines
COUNTRY OF ORIGIN: United States

PACKAGE INFORMATION:
Number of Packages: 2 (two cartons)
Gross Weight: 18.3 KG
Net Weight: 15.5 KG
Volume: 0.048 cubic meters
Dimensions: 60cm x 40cm x 20cm (per carton)

DECLARED CUSTOMS VALUE: USD 8,950.00
FREIGHT: USD 320.00
INSURANCE: USD 89.50
TOTAL CIF VALUE: USD 9,359.50

DUAL-USE CHECK: NO — goods do not appear on dual-use control lists
EXPORT LICENSE REQUIRED: NO
SANCTIONS SCREENING: CLEAR

Declared by: James Mitchell, Export Manager, Global Exports Ltd
Date: ${date}`;
  },

  BILL_OF_LADING: () => {
    const bolNum = `BOL-MSK-2026-${Math.floor(Math.random() * 9000) + 1000}`;
    const date = new Date().toISOString().split('T')[0];
    return `BILL OF LADING
Maersk Line — Ocean Bill of Lading

B/L Number: ${bolNum}
Date of Issue: ${date}
Place of Issue: New York, USA

SHIPPER:
Global Exports Ltd
100 Commerce Boulevard
New York, NY 10001, USA

CONSIGNEE:
European Imports GmbH
25 Handelstraße, Hamburg 20095, Germany

NOTIFY PARTY:
European Imports GmbH (same as consignee)

VESSEL AND VOYAGE:
Vessel Name: MV Atlantic Carrier
Voyage Number: ATL-2026-18
Port of Loading: New York, USA (USNYC)
Port of Discharge: Hamburg, Germany (DEHAM)
Estimated Departure: ${date}
Estimated Arrival: within 14 days of departure

CARGO DESCRIPTION:
2 cartons — Laptop computers and accessories
Shipper's description: Electronic equipment — laptop computers

CONTAINER / PACKAGE DETAILS:
Container No: MSCU7654321-4
Seal No: SL-987654
Number of Packages: 2 cartons
Gross Weight: 18.3 KG
Measurement: 0.048 CBM

FREIGHT DETAILS:
Freight: PREPAID
Carrier: Maersk Line
Carrier SCAC Code: MAEU

TERMS:
Shipped on board in apparent good order and condition.
FREIGHT PREPAID. ONE ORIGINAL BILL OF LADING.

Signed for and on behalf of Maersk Line
Master: Capt. R. Hansen
Date: ${date}`;
  },

  SHIPPING_LABEL: () => {
    const trkNum = `CT-2026-${Math.floor(Math.random() * 900000) + 100000}`;
    const date = new Date().toISOString().split('T')[0];
    return `SHIPPING LABEL — INTERNATIONAL EXPRESS

Tracking Number: ${trkNum}
Service Type: INTERNATIONAL PRIORITY
Date of Shipment: ${date}

FROM:
Global Exports Ltd
100 Commerce Blvd, Suite 400
New York, NY 10001
United States
Contact: +1 (212) 555-0142

TO:
European Imports GmbH
25 Handelstraße
Hamburg, 20095
Germany
Contact: +49 40 555 0876

PACKAGE DETAILS:
Weight: 15.5 KG (gross)
Dimensions: 60 x 40 x 20 CM
Service: EXPRESS — 5-7 business days
Carrier: DHL Express
AWB: 1234 5678 9012

CONTENTS: Electronic equipment
Declared Value: USD 8,950.00

HANDLING INSTRUCTIONS:
THIS SIDE UP ↑
FRAGILE — HANDLE WITH CARE
DO NOT STACK MORE THAN 3 HIGH

Barcode: [|||||||||||||| ${trkNum} ||||||||||||||]`;
  },

  SHIPPING_MANIFEST: () => {
    const manNum = `MAN-2026-${Math.floor(Math.random() * 9000) + 1000}`;
    const date = new Date().toISOString().split('T')[0];
    return `SHIPPING MANIFEST

Manifest Number: ${manNum}
Date: ${date}
Manifest Type: CARGO MANIFEST

VESSEL / CARRIER INFORMATION:
Carrier: Maersk Line
Vessel: MV Atlantic Carrier
Voyage: ATL-2026-18
Port of Loading: New York, USA
Port of Discharge: Hamburg, Germany

CONSIGNMENT SUMMARY:
Total Packages: 2 cartons
Total Gross Weight: 18.3 KG
Total Net Weight: 15.5 KG
Total Volume: 0.048 CBM
Total Declared Value: USD 9,359.50

PACKAGE LISTING:
Package 1 of 2:
  Description: Laptop Computers (10 units)
  HS Code: 8471.30.00
  Gross Weight: 9.2 KG
  Dimensions: 60 x 40 x 20 CM
  Hazardous: NO
  Refrigeration Required: NO
  Battery: YES (lithium-ion internal)

Package 2 of 2:
  Description: Laptop Carrying Cases (10 units)
  HS Code: 4202.12.00
  Gross Weight: 9.1 KG
  Dimensions: 60 x 40 x 20 CM
  Hazardous: NO

SPECIAL HANDLING:
Fragile goods: YES
Temperature sensitive: NO
Hazardous materials: NO
Lithium battery declaration: Required per IATA DGR Section II

CERTIFICATION: I certify this manifest is accurate and complete.
Authorized by: Global Exports Ltd, ${date}`;
  },

  PROOF_OF_DELIVERY: () => {
    const date = new Date().toISOString().split('T')[0];
    return `PROOF OF DELIVERY RECEIPT

Delivery Reference: POD-DEHAM-2026-${Math.floor(Math.random() * 9000) + 1000}
Delivery Date: ${date}
Delivery Time: 14:32 local time

DELIVERED TO:
European Imports GmbH
Hamburg Port, Dock 14, Warehouse B
Hamburg, 20097, Germany

RECEIVED BY:
Name: Hans Mueller
Position: Warehouse Manager
Signature: H. Mueller (signed)
ID Verified: YES

PACKAGE CONDITION:
Number of Packages Received: 2
Packages Intact: YES
Visible Damage: NONE
Seals Intact: YES (Seal SL-987654 verified unbroken)

DELIVERY NOTES:
All 2 cartons received in good condition.
No shortage reported.
Temperature integrity maintained (not applicable — non-perishable goods).
Delivery completed without incident.

CARRIER REPRESENTATIVE:
Name: Klaus Weber, Maersk Line Delivery Agent
Date: ${date}
Signature: K. Weber (signed)`;
  },

  OTHER: () => `UNCLASSIFIED DOCUMENT

This document has not been classified into a recognized shipping document type.
Content requires manual review by the compliance team.

File received: ${new Date().toISOString()}
Classification: UNCLASSIFIED
Action Required: Manual review and proper document type assignment.`,
};

export class MockExtractor implements DocumentExtractor {
  readonly name = 'MockExtractor';

  // Always available as final fallback
  canHandle(_doc: DocumentRecord): boolean {
    return true;
  }

  async extract(doc: DocumentRecord): Promise<ExtractedDocumentText> {
    const textFn = MOCK_DOCUMENT_TEXT[doc.documentType] ?? MOCK_DOCUMENT_TEXT.OTHER;
    const rawText = textFn();

    console.log(`[MockExtractor] Returning realistic document text for ${doc.documentType} (doc: ${doc.id})`);

    return {
      documentId: doc.id,
      documentType: doc.documentType,
      rawText,
      extractionMethod: 'mock',
      confidence: 0.92,
      pageCount: 1,
    };
  }
}

export const mockExtractor = new MockExtractor();
