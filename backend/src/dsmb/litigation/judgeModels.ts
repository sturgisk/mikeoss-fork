import {
    isKnownModel,
    JUDGE_MODEL_CANDIDATES,
    providerForModel,
} from "../../lib/llm/models";
import type { UserApiKeys } from "../../lib/llm";

export type JudgeModelOption = {
    id: string;
    label: string;
    provider: "claude" | "gemini" | "openai";
    available: boolean;
};

const JUDGE_LABELS: Record<string, string> = {
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
    "gemini-3.5-flash": "Gemini 3.5 Flash",
    "gemini-3-flash-preview": "Gemini 3 Flash",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "gpt-5.4-lite": "GPT-5.4 Lite",
    "gpt-5.4": "GPT-5.4",
};

function providerHasKey(
    provider: "claude" | "gemini" | "openai",
    keys: UserApiKeys,
): boolean {
    if (provider === "claude") return !!keys.claude?.trim();
    if (provider === "openai") return !!keys.openai?.trim();
    return !!keys.gemini?.trim();
}

export function listJudgeModelOptions(apiKeys: UserApiKeys): JudgeModelOption[] {
    return JUDGE_MODEL_CANDIDATES.filter(isKnownModel).map((id) => {
        const provider = providerForModel(id);
        return {
            id,
            label: JUDGE_LABELS[id] ?? id,
            provider,
            available: providerHasKey(provider, apiKeys),
        };
    });
}

export function validateJudgeModels(
    modelIds: unknown,
    apiKeys: UserApiKeys,
): string[] {
    if (!Array.isArray(modelIds)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of modelIds) {
        if (typeof raw !== "string") continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        if (!isKnownModel(id)) {
            throw new Error(`Unknown judge model: ${id}`);
        }
        const provider = providerForModel(id);
        if (!providerHasKey(provider, apiKeys)) {
            throw new Error(
                `No API key configured for judge model ${id} (${provider}).`,
            );
        }
        seen.add(id);
        result.push(id);
        if (result.length >= 5) break;
    }
    return result;
}
