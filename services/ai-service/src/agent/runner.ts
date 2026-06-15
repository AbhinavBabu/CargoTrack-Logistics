import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { AgentDataAccess, COMPLIANCE_AGENT_TOOLS, ComplianceTriggerMessage } from './contracts';

// ─── System Prompt ────────────────────────────────────────────────────────────
// Works with Amazon Nova Pro, Nova Lite, and all Claude 3+ models.
// The Converse API format is identical across providers.

const SYSTEM_PROMPT = `You are the CargoTrack Document Compliance Agent.

Your job is to verify that all required shipping documents have been uploaded
for a shipment, extract key fields from those documents, and check them for
data consistency.

You have access to tools to:
1. Retrieve the shipment record
2. Get the list of uploaded documents
3. Determine which document types are required
4. Extract fields from each document
5. Create compliance findings when issues are detected
6. Finalize the compliance report

## Compliance Checks
Run the following checks in order:
1. COMPLETENESS: Are all required document types uploaded?
   - Missing documents → create a MISSING_DOCUMENT finding with severity HIGH
2. FIELD EXTRACTION: For each uploaded document, extract key fields
3. CONSISTENCY: Cross-check fields across documents
   - Carrier name on INVOICE vs BILL_OF_LADING must match (if both present)
   - Weight on SHIPPING_LABEL must be within 10% of the shipment record weight
   - Sender/receiver names should match across documents
   - Data mismatches → create DATA_MISMATCH finding with severity MEDIUM or HIGH
4. RISK: Flag any potential compliance risks you identify

## Severity Guidelines
- CRITICAL: Missing CUSTOMS for international shipment, or fraudulent data indicators
- HIGH: Missing required document, significant data mismatch
- MEDIUM: Minor data inconsistency, missing optional field
- LOW: Cosmetic issues, minor formatting problems

## Finalization
After all checks, call finalize_report with:
- PASSED: No HIGH or CRITICAL findings
- FAILED: One or more CRITICAL or HIGH findings
- PARTIAL: All documents present but extraction confidence < 0.7

Always finalize the report. Never leave it in PENDING state.`;

// ─── Mock Runner ──────────────────────────────────────────────────────────────
// Used when MOCK_AGENT=true or AWS credentials are absent.
// Runs a simulated compliance check using only the tools, no Bedrock call.

async function runMockAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentDataAccess
): Promise<void> {
  const agentRunId = `mock-${randomUUID()}`;
  console.log(`[agent][MOCK] Starting mock compliance run — agentRunId: ${agentRunId}`);

  // Step 1: Get shipment
  const shipment = await tools.getShipment(trigger.shipmentId);
  if (!shipment) {
    console.error(`[agent][MOCK] Shipment not found: ${trigger.shipmentId}`);
    return;
  }

  // Step 2: Create report
  const { id: reportId } = await tools.createReport({
    shipmentId: trigger.shipmentId,
    agentRunId,
  });

  // Step 3: Get uploaded docs and required types
  const uploaded = await tools.getDocuments(trigger.shipmentId);
  const required = tools.getRequiredDocumentTypes(
    shipment.shipmentType,
    shipment.origin,
    shipment.destination
  );

  const uploadedTypes = new Set(uploaded.map((d) => d.documentType));
  const findings: string[] = [];

  // Step 4: Check completeness
  for (const reqType of required) {
    if (!uploadedTypes.has(reqType)) {
      await tools.createFinding({
        reportId,
        findingType: 'MISSING_DOCUMENT',
        severity: 'HIGH',
        description: `Required document type ${reqType} has not been uploaded.`,
        detail: { expected: reqType, found: 'NONE' },
      });
      findings.push(`MISSING:${reqType}`);
    }
  }

  // Step 5: Extract fields and check consistency
  for (const doc of uploaded) {
    const extracted = await tools.extractDocumentFields(doc);

    // Weight consistency check (SHIPPING_LABEL)
    if (doc.documentType === 'SHIPPING_LABEL' && extracted.fields.weight) {
      const extractedWeight = parseFloat(extracted.fields.weight);
      const tolerance = shipment.weight * 0.1; // 10%
      if (Math.abs(extractedWeight - shipment.weight) > tolerance) {
        await tools.createFinding({
          reportId,
          documentId: doc.id,
          findingType: 'DATA_MISMATCH',
          severity: 'MEDIUM',
          description: `Shipping label weight (${extractedWeight}kg) differs from shipment record (${shipment.weight}kg) by more than 10%.`,
          detail: {
            field: 'weight',
            expected: String(shipment.weight),
            found: String(extractedWeight),
          },
        });
        findings.push('WEIGHT_MISMATCH');
      }
    }

    // Carrier consistency check (BILL_OF_LADING vs shipment record)
    if (
      doc.documentType === 'BILL_OF_LADING' &&
      extracted.fields.carrier &&
      shipment.carrierName &&
      !extracted.fields.carrier
        .toLowerCase()
        .includes(shipment.carrierName.toLowerCase())
    ) {
      await tools.createFinding({
        reportId,
        documentId: doc.id,
        findingType: 'DATA_MISMATCH',
        severity: 'HIGH',
        description: `Carrier on Bill of Lading ("${extracted.fields.carrier}") does not match shipment record ("${shipment.carrierName}").`,
        detail: {
          field: 'carrier',
          expected: shipment.carrierName,
          found: extracted.fields.carrier,
        },
      });
      findings.push('CARRIER_MISMATCH');
    }
  }

  // Step 6: Finalize
  const hasHigh = findings.some((f) => f.includes('MISSING') || f.includes('MISMATCH'));
  const status = hasHigh ? 'FAILED' : findings.length > 0 ? 'PARTIAL' : 'PASSED';

  const summary = status === 'PASSED'
    ? `All ${required.length} required document(s) present. No compliance issues found.`
    : `Compliance check complete. ${findings.length} finding(s) detected: ${findings.join(', ')}.`;

  await tools.finalizeReport(reportId, status, summary);

  await tools.publishAuditEvent({
    shipmentId: trigger.shipmentId,
    eventType: `compliance.${status.toLowerCase()}`,
    summary,
    agentRunId,
    timestamp: new Date().toISOString(),
  });

  console.log(`[agent][MOCK] Completed — status: ${status}, findings: ${findings.length}`);
}

// ─── Real Bedrock Runner (Nova / Claude via Converse API) ─────────────────────

async function runBedrockAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentDataAccess
): Promise<void> {
  const agentRunId = randomUUID();
  console.log(`[agent][BEDROCK] Starting compliance run — model: ${config.bedrockModelId}, runId: ${agentRunId}`);

  const client = new BedrockRuntimeClient({ region: config.region });

  // Convert our tool specs to the Bedrock Converse format.
  // We do NOT annotate as Tool[] because the SDK's internal __DocumentType
  // phantom-type on inputSchema.json rejects plain objects at compile time.
  // Casting to the parameter type at the call site (toolConfig.tools) is
  // sufficient — the runtime shape is correct.
  const bedrockTools = COMPLIANCE_AGENT_TOOLS.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      // The SDK requires inputSchema.json to be a plain JSON Schema object.
      // Using 'as unknown as Record<string,unknown>' avoids the __DocumentType
      // phantom-type conflict while preserving the correct runtime value.
      inputSchema: { json: t.inputSchema.json as unknown as Record<string, unknown> },
    },
  }));

  // Seed the conversation with the initial task
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          text: `Please perform a full compliance check for shipment ID: ${trigger.shipmentId} (tracking: ${trigger.trackingNumber}). The shipment has just reached status: ${trigger.newStatus}. Agent run ID: ${agentRunId}.`,
        },
      ],
    },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 20; // safety guard against infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const command = new ConverseCommand({
      modelId: config.bedrockModelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolConfig: { tools: bedrockTools as any },
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0,   // deterministic compliance checks
      },
    });

    const response = await client.send(command);
    const { output, stopReason } = response;

    if (!output?.message) {
      console.error('[agent][BEDROCK] No message in response');
      break;
    }

    // Add the model's response to the conversation
    messages.push(output.message);

    if (stopReason === 'end_turn') {
      console.log('[agent][BEDROCK] Agent finished (end_turn)');
      break;
    }

    if (stopReason !== 'tool_use') {
      console.log(`[agent][BEDROCK] Unexpected stop reason: ${stopReason}`);
      break;
    }

    // Process tool use blocks
    const toolResults: ContentBlock[] = [];

    for (const block of output.message.content ?? []) {
      if (block.toolUse) {
        const { toolUseId, name, input } = block.toolUse;
        console.log(`[agent][BEDROCK] Tool call: ${name}`, input);

        let resultRaw: unknown;

        try {
          resultRaw = await dispatchToolCall(name ?? '', input as Record<string, unknown>, tools, agentRunId);
        } catch (err) {
          resultRaw = { error: String(err) };
          console.error(`[agent][BEDROCK] Tool error (${name}):`, err);
        }

        // toolResult.content[].json requires Record<string, unknown>.
        // Array results (e.g. DocumentType[] from determine_required_documents)
        // are wrapped in { result: [...] } to satisfy the type constraint.
        const resultObj: Record<string, unknown> =
          resultRaw === null || resultRaw === undefined
            ? { result: null }
            : Array.isArray(resultRaw)
            ? { result: resultRaw }
            : typeof resultRaw === 'object'
            ? (resultRaw as Record<string, unknown>)
            : { result: resultRaw };

        toolResults.push({
          toolResult: {
            toolUseId,
            content: [{ json: resultObj }],
          },
        } as ContentBlock);
      }
    }

    // Feed tool results back into the conversation
    messages.push({ role: 'user', content: toolResults });
  }

  if (iterations >= MAX_ITERATIONS) {
    console.warn(`[agent][BEDROCK] Hit MAX_ITERATIONS (${MAX_ITERATIONS}) — forcing PARTIAL finalization`);
    // Safety: ensure report isn't left as PENDING
    const report = await tools.createReport({ shipmentId: trigger.shipmentId, agentRunId });
    await tools.finalizeReport(report.id, 'PARTIAL', 'Agent iteration limit reached.');
  }
}

// ─── Tool Dispatcher ──────────────────────────────────────────────────────────
// Maps Bedrock tool names → AgentDataAccess method calls.
// The snake_case names match COMPLIANCE_AGENT_TOOLS exactly.

async function dispatchToolCall(
  name: string,
  input: Record<string, unknown>,
  tools: AgentDataAccess,
  agentRunId: string
): Promise<unknown> {
  switch (name) {
    case 'get_shipment_record':
      return tools.getShipment(input.shipment_id as string);

    case 'get_uploaded_documents':
      return tools.getDocuments(input.shipment_id as string);

    case 'determine_required_documents':
      return tools.getRequiredDocumentTypes(
        input.shipment_type as string,
        input.origin as string,
        input.destination as string
      );

    case 'extract_document_fields': {
      // The agent passes document_id; we look it up directly to get the full record.
      const { PrismaClient: PC } = await import('@prisma/client');
      const p = new PC();
      const doc = await p.shipmentDocument.findUnique({
        where: { id: input.document_id as string },
      });
      await p.$disconnect();
      if (!doc) return { error: 'Document not found' };
      return tools.extractDocumentFields({
        id: doc.id,
        originalName: doc.originalName,
        fileName: doc.fileName,
        documentType: doc.documentType,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        uploadedAt: doc.uploadedAt,
      });
    }

    case 'create_compliance_finding':
      return tools.createFinding({
        reportId: input.report_id as string,
        documentId: input.document_id as string | undefined,
        findingType: input.finding_type as any,
        severity: input.severity as any,
        description: input.description as string,
        detail: input.detail as any,
      });

    case 'create_compliance_report':
      return tools.createReport({
        shipmentId: input.shipment_id as string,
        agentRunId,
      });

    case 'finalize_report':
      await tools.finalizeReport(
        input.report_id as string,
        input.status as 'PASSED' | 'FAILED' | 'PARTIAL',
        input.summary as string
      );
      return { success: true };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runComplianceAgent(
  trigger: ComplianceTriggerMessage,
  tools: AgentDataAccess
): Promise<void> {
  if (config.mockAgent) {
    return runMockAgent(trigger, tools);
  }
  return runBedrockAgent(trigger, tools);
}
