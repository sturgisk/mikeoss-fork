import { z } from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
    buildProjectDocContext,
    extractPdfText,
    generateDocx,
} from "../../lib/chatTools";
import { createServerSupabase } from "../../lib/supabase";
import { downloadFile } from "../../lib/storage";
import {
    getCourtlistenerCases,
    searchCourtlistenerCaseLaw,
    verifyCourtlistenerCitations,
} from "../../lib/courtlistener";
import { getUserApiKeys } from "../../lib/userApiKeys";
import type { MikeBridgeContext } from "./types";
import { listVaultFiles, readVaultFile, writeVaultFile } from "./vault";

type BridgeModule = {
    createSdkMcpServer: (opts: {
        name: string;
        version?: string;
        instructions?: string;
        tools?: unknown[];
    }) => unknown;
    tool: (
        name: string,
        description: string,
        schema: z.ZodRawShape,
        handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
    ) => unknown;
};

async function loadBridgeModule(): Promise<BridgeModule> {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as BridgeModule;
    return mod;
}

function textResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
    return textResult(JSON.stringify(value, null, 2));
}

async function readProjectDocumentText(
    ctx: MikeBridgeContext,
    docLabel: string,
): Promise<string> {
    const db = createServerSupabase();
    const { docIndex, docStore } = await buildProjectDocContext(
        ctx.projectId,
        ctx.userId,
        db,
    );
    const info = docStore.get(docLabel);
    if (!info?.storage_path) {
        return `Document "${docLabel}" not found. Known labels: ${Object.keys(docIndex).join(", ")}`;
    }
    const raw = await downloadFile(info.storage_path);
    if (!raw) return `Could not download document "${docLabel}".`;
    const fileType = (info.file_type ?? "").toLowerCase();
    if (fileType === "pdf") {
        const text = await extractPdfText(raw);
        return text || "(PDF had no extractable text.)";
    }
    if (fileType === "docx" || fileType === "doc") {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({
            buffer: Buffer.from(raw),
        });
        return result.value || "(Document had no extractable text.)";
    }
    return Buffer.from(raw).toString("utf8");
}

export async function createMikeBridgeMcpServer(ctx: MikeBridgeContext) {
    const { createSdkMcpServer, tool } = await loadBridgeModule();
    const db = createServerSupabase();

    return createSdkMcpServer({
        name: "mike-bridge",
        version: "1.0.0",
        instructions:
            "Mike litigation bridge. Use these tools for matter vault files, project documents, and CourtListener research. Built-in Claude Code tools are disabled in this session.",
        tools: [
            tool(
                "list_vault_files",
                "List markdown files in the matter vault.",
                {},
                async () => jsonResult(await listVaultFiles(ctx.projectId, db)),
            ),
            tool(
                "read_vault_file",
                "Read a markdown file from the matter vault by path (e.g. analysis/claims-chart.md).",
                { path: z.string().describe("Vault-relative path") },
                async (args) => {
                    const content = await readVaultFile(
                        ctx.projectId,
                        String(args.path),
                        db,
                    );
                    return textResult(content ?? "(file not found)");
                },
            ),
            tool(
                "write_vault_file",
                "Write or overwrite a markdown file in the matter vault.",
                {
                    path: z.string().describe("Vault-relative path"),
                    content: z.string().describe("Full file content"),
                },
                async (args) =>
                    jsonResult(
                        await writeVaultFile(
                            ctx.projectId,
                            String(args.path),
                            String(args.content),
                            db,
                        ),
                    ),
            ),
            tool(
                "list_project_documents",
                "List documents in the current matter/project with doc-N labels.",
                {},
                async () => {
                    const { docIndex, folderPaths } = await buildProjectDocContext(
                        ctx.projectId,
                        ctx.userId,
                        db,
                    );
                    const docs = Object.entries(docIndex).map(([label, info]) => ({
                        label,
                        filename: info.filename,
                        document_id: info.document_id,
                        folder: folderPaths.get(label) ?? null,
                    }));
                    return jsonResult(docs);
                },
            ),
            tool(
                "read_project_document",
                "Read extracted text from a project document by label (e.g. doc-0).",
                {
                    doc_label: z
                        .string()
                        .describe("Document label from list_project_documents"),
                },
                async (args) =>
                    textResult(
                        await readProjectDocumentText(ctx, String(args.doc_label)),
                    ),
            ),
            tool(
                "courtlistener_search_case_law",
                "Search US case law on CourtListener.",
                {
                    query: z.string(),
                    limit: z.number().optional(),
                },
                async (args) => {
                    const keys = await getUserApiKeys(ctx.userId, db);
                    const result = await searchCourtlistenerCaseLaw({
                        query: String(args.query),
                        limit: typeof args.limit === "number" ? args.limit : 10,
                        apiToken: keys.courtlistener,
                    });
                    return jsonResult(result);
                },
            ),
            tool(
                "courtlistener_verify_citations",
                "Verify reporter citations on CourtListener.",
                {
                    citations: z.array(z.string()),
                },
                async (args) => {
                    const keys = await getUserApiKeys(ctx.userId, db);
                    const citations = Array.isArray(args.citations)
                        ? args.citations.map(String)
                        : [];
                    const result = await verifyCourtlistenerCitations({
                        citations,
                        apiToken: keys.courtlistener,
                    });
                    return jsonResult(result);
                },
            ),
            tool(
                "courtlistener_get_cases",
                "Fetch CourtListener case clusters by cluster ID.",
                {
                    cluster_ids: z.array(z.number()),
                },
                async (args) => {
                    const keys = await getUserApiKeys(ctx.userId, db);
                    const clusterIds = Array.isArray(args.cluster_ids)
                        ? args.cluster_ids.map(Number)
                        : [];
                    const result = await getCourtlistenerCases({
                        clusterIds,
                        apiToken: keys.courtlistener,
                    });
                    return jsonResult(result);
                },
            ),
            tool(
                "generate_docx",
                "Generate a Word (.docx) motion or brief and attach it to this matter project. Returns download_url and document_id.",
                {
                    title: z.string().describe("Document title and filename stem"),
                    sections: z
                        .array(
                            z.object({
                                heading: z.string().optional(),
                                level: z.number().optional(),
                                content: z.string().optional(),
                                pageBreak: z.boolean().optional(),
                                table: z
                                    .object({
                                        headers: z.array(z.string()),
                                        rows: z.array(z.array(z.string())),
                                    })
                                    .optional(),
                            }),
                        )
                        .describe("Structured document sections"),
                    landscape: z
                        .boolean()
                        .optional()
                        .describe("Landscape orientation if true"),
                },
                async (args) => {
                    const title = String(args.title ?? "Motion to Dismiss");
                    const sections = Array.isArray(args.sections)
                        ? args.sections
                        : [];
                    const landscape =
                        typeof args.landscape === "boolean"
                            ? args.landscape
                            : false;
                    const result = await generateDocx(
                        title,
                        sections,
                        ctx.userId,
                        db,
                        { landscape, projectId: ctx.projectId },
                    );
                    if (
                        result &&
                        typeof result === "object" &&
                        "download_url" in result
                    ) {
                        await writeVaultFile(
                            ctx.projectId,
                            "drafts/mtd-export.json",
                            JSON.stringify(result, null, 2),
                            db,
                        );
                    }
                    return jsonResult(result);
                },
            ),
        ],
    });
}

export const MIKE_BRIDGE_TOOL_PREFIX = "mcp__mike-bridge__";

export function mikeBridgeBuiltinBlockedTools(): string[] {
    return [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "Skill",
    ];
}

export function isMikeBridgeToolName(
    toolName: string,
    allowAgent: boolean,
): boolean {
    if (allowAgent && toolName === "Agent") return true;
    if (toolName.startsWith(MIKE_BRIDGE_TOOL_PREFIX)) return true;
    return mikeBridgeAllowedTools().includes(toolName);
}

export function mikeBridgeAllowedTools(): string[] {
    return [
        `${MIKE_BRIDGE_TOOL_PREFIX}list_vault_files`,
        `${MIKE_BRIDGE_TOOL_PREFIX}read_vault_file`,
        `${MIKE_BRIDGE_TOOL_PREFIX}write_vault_file`,
        `${MIKE_BRIDGE_TOOL_PREFIX}list_project_documents`,
        `${MIKE_BRIDGE_TOOL_PREFIX}read_project_document`,
        `${MIKE_BRIDGE_TOOL_PREFIX}courtlistener_search_case_law`,
        `${MIKE_BRIDGE_TOOL_PREFIX}courtlistener_verify_citations`,
        `${MIKE_BRIDGE_TOOL_PREFIX}courtlistener_get_cases`,
        `${MIKE_BRIDGE_TOOL_PREFIX}generate_docx`,
    ];
}
