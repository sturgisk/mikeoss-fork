import os from "os";
import path from "path";
import fs from "fs/promises";
import type { AgentDefinition as SdkAgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { getUserApiKeys } from "../../lib/userApiKeys";
import { createServerSupabase } from "../../lib/supabase";
import { applyVariantTemplate } from "./processDefinitions";
import type {
    AgentDefinition,
    MikeBridgeContext,
    ProcessDefinition,
    ProcessVariantDefinition,
    SubagentDefinition,
} from "./types";
import {
    createMikeBridgeMcpServer,
    mikeBridgeAllowedTools,
    mikeBridgeBuiltinBlockedTools,
    isMikeBridgeToolName,
} from "./mikeBridgeMcp";

export type AgentPhaseResult = {
    transcript: string;
    messages: unknown[];
};

function buildSdkSubagents(
    agent: AgentDefinition,
    process: ProcessDefinition,
    variant: ProcessVariantDefinition,
): Record<string, SdkAgentDefinition> | undefined {
    const ids = agent.subagents ?? [];
    if (!ids.length) return undefined;
    const bridgeTools = mikeBridgeAllowedTools();
    const blocked = mikeBridgeBuiltinBlockedTools();
    const result: Record<string, SdkAgentDefinition> = {};
    for (const id of ids) {
        const sub: SubagentDefinition | undefined =
            process.subagents?.[id] ?? process.agents[id];
        if (!sub) continue;
        result[id] = {
            description: sub.description,
            prompt: applyVariantTemplate(sub.system_prompt, variant),
            maxTurns: sub.max_turns,
            tools: bridgeTools,
            disallowedTools: [...blocked, "Agent"],
        };
    }
    return Object.keys(result).length ? result : undefined;
}

export async function runLitigationAgentPhase(params: {
    ctx: MikeBridgeContext;
    agent: AgentDefinition;
    process: ProcessDefinition;
    variant: ProcessVariantDefinition;
    phasePrompt: string;
    onEvent?: (event: unknown) => void | Promise<void>;
    abortSignal?: AbortSignal;
}): Promise<AgentPhaseResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const db = createServerSupabase();
    const keys = await getUserApiKeys(params.ctx.userId, db);
    const anthropicKey =
        keys.claude?.trim() ?? process.env.ANTHROPIC_API_KEY?.trim();
    if (!anthropicKey) {
        throw new Error(
            "Anthropic API key is required for litigation agents. Configure ANTHROPIC_API_KEY or add a user Claude key.",
        );
    }

    const mikeBridge = await createMikeBridgeMcpServer(params.ctx);
    const systemPrompt = applyVariantTemplate(
        params.agent.system_prompt,
        params.variant,
    );
    const sdkSubagents = buildSdkSubagents(
        params.agent,
        params.process,
        params.variant,
    );
    const allowAgentDelegation = !!sdkSubagents && Object.keys(sdkSubagents).length > 0;
    const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), `dsmb-run-${params.ctx.runId}-`),
    );

    const messages: unknown[] = [];
    let transcript = "";

    try {
        const bridgeTools = mikeBridgeAllowedTools();
        const allowed = allowAgentDelegation
            ? [...bridgeTools, "Agent"]
            : bridgeTools;
        const blockedBuiltins = mikeBridgeBuiltinBlockedTools();

        const agentLoop = query({
            prompt: params.phasePrompt,
            options: {
                cwd: workspace,
                tools: [],
                disallowedTools: blockedBuiltins,
                allowedTools: allowed,
                agents: sdkSubagents,
                mcpServers: {
                    "mike-bridge": mikeBridge as import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance,
                },
                systemPrompt,
                maxTurns: params.agent.max_turns,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                env: {
                    ...process.env,
                    ANTHROPIC_API_KEY: anthropicKey,
                    CLAUDE_AGENT_SDK_CLIENT_APP: "dsmb-litigation/0.1.0",
                },
                abortController: params.abortSignal
                    ? (() => {
                          const ac = new AbortController();
                          params.abortSignal?.addEventListener("abort", () =>
                              ac.abort(),
                          );
                          return ac;
                      })()
                    : undefined,
                canUseTool: async (toolName) => {
                    if (isMikeBridgeToolName(toolName, allowAgentDelegation)) {
                        return { behavior: "allow" as const };
                    }
                    return {
                        behavior: "deny" as const,
                        message:
                            "Only Mike bridge MCP tools and Agent delegation are permitted in managed litigation runs.",
                    };
                },
            },
        });

        for await (const message of agentLoop) {
            messages.push(message);
            await params.onEvent?.(message);
            const record = message as Record<string, unknown>;
            if (record.type === "assistant") {
                const msg = record.message as { content?: unknown[] } | undefined;
                for (const block of msg?.content ?? []) {
                    const b = block as { type?: string; text?: string };
                    if (b.type === "text" && b.text) transcript += b.text;
                }
            }
            if (record.type === "result") {
                const result = record as { result?: string };
                if (typeof result.result === "string" && result.result.trim()) {
                    transcript = result.result;
                }
            }
        }
    } finally {
        await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }

    return { transcript, messages };
}

export function buildPhasePrompt(params: {
    phaseTitle: string;
    variant: ProcessVariantDefinition;
    hitlContext?: Record<string, unknown>;
}): string {
    const lines = [
        `Execute phase: ${params.phaseTitle}`,
        `Variant: ${params.variant.title}`,
        `Focus: ${params.variant.focus}`,
    ];
    if (params.hitlContext && Object.keys(params.hitlContext).length) {
        lines.push(
            "Human review input from prior step:",
            JSON.stringify(params.hitlContext, null, 2),
        );
    }
    lines.push(
        "Write outputs to the matter vault using write_vault_file (directly or via vault-writer subagent). Read existing vault files before overwriting.",
        "When subagents are available, delegate specialized work using the Agent tool rather than doing everything in one pass.",
    );
    return lines.join("\n\n");
}
