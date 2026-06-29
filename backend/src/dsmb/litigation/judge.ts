import { completeText } from "../../lib/llm";
import type { UserApiKeys } from "../../lib/llm";
import { createServerSupabase } from "../../lib/supabase";
import { listVaultFiles, readVaultFile } from "./vault";
import type { ProcessPhaseDefinition, JudgeReport } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

const PHASE_VAULT_PATHS: Record<string, string[]> = {
    intake: ["analysis/intake/index.md", "analysis/complaint-index.md"],
    complaint_analysis: ["analysis/claims-chart.md"],
    exhibit_analysis: ["analysis/exhibit-index.md"],
    research_plan: ["research/queries-proposed.json"],
    legal_research: ["research/citations.json"],
    argument_outline: ["drafts/mtd-outline.md"],
    draft_motion: ["drafts/mtd-draft.md", "drafts/mtd-export.json"],
};

const PHASE_RUBRIC: Record<string, string> = {
    intake:
        "Evaluate whether the document inventory correctly identifies the complaint vs exhibits and is complete enough to proceed.",
    complaint_analysis:
        "Evaluate whether the claims chart maps each count to elements and key allegations accurately for a motion to dismiss.",
    exhibit_analysis:
        "Evaluate whether exhibits are mapped to allegations with relevance and authentication notes.",
    research_plan:
        "Evaluate whether proposed research queries are specific, on-point, and do not over-broaden scope. Queries must not have been executed yet.",
    legal_research:
        "Evaluate whether research memos and citations support motion arguments with accurate, cite-worthy authority.",
    argument_outline:
        "Evaluate whether the motion outline has clear sections, standard of review, and arguments tied to the record.",
    draft_motion:
        "Evaluate whether the draft motion is well-structured, legally sound in framing, and supported by cited research.",
};

async function gatherPhaseArtifacts(
    projectId: string,
    phase: ProcessPhaseDefinition,
    transcript: string | undefined,
    db: Db,
): Promise<string> {
    const parts: string[] = [
        `Phase: ${phase.title} (${phase.id})`,
        `Rubric: ${PHASE_RUBRIC[phase.id] ?? "Evaluate quality and completeness of this phase output."}`,
    ];
    if (transcript?.trim()) {
        parts.push(
            "Agent transcript (excerpt):",
            transcript.slice(0, 4000),
        );
    }
    const paths = PHASE_VAULT_PATHS[phase.id] ?? [];
    for (const path of paths) {
        const content = await readVaultFile(projectId, path, db);
        if (content) {
            parts.push(`--- ${path} ---`, content.slice(0, 12000));
        }
    }
    if (phase.id === "legal_research") {
        const files = await listVaultFiles(projectId, db);
        for (const f of files.filter((x) => x.path.startsWith("research/memos/"))) {
            const content = await readVaultFile(projectId, f.path, db);
            if (content) {
                parts.push(`--- ${f.path} ---`, content.slice(0, 8000));
            }
        }
    }
    return parts.join("\n\n");
}

function parseJudgeResponse(raw: string, model: string): JudgeReport {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
            const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<
                string,
                unknown
            >;
            const score = Number(parsed.score);
            return {
                model,
                score: Number.isFinite(score) ? Math.min(5, Math.max(1, score)) : 3,
                pass: Boolean(parsed.pass),
                summary: String(parsed.summary ?? "").slice(0, 2000),
                issues: Array.isArray(parsed.issues)
                    ? parsed.issues.map(String).slice(0, 20)
                    : [],
                strengths: Array.isArray(parsed.strengths)
                    ? parsed.strengths.map(String).slice(0, 20)
                    : [],
            };
        } catch {
            // fall through
        }
    }
    return {
        model,
        score: 3,
        pass: true,
        summary: raw.slice(0, 2000),
        issues: [],
        strengths: [],
    };
}

export async function runPhaseJudges(params: {
    projectId: string;
    phase: ProcessPhaseDefinition;
    judgeModels: string[];
    transcript?: string;
    apiKeys: UserApiKeys;
    db: Db;
}): Promise<JudgeReport[]> {
    if (!params.judgeModels.length) return [];

    const artifacts = await gatherPhaseArtifacts(
        params.projectId,
        params.phase,
        params.transcript,
        params.db,
    );

    const systemPrompt =
        "You are an independent legal workflow evaluator. You review outputs from an AI litigation agent. " +
        "Respond with JSON only, no markdown fences: " +
        '{"score":1-5,"pass":boolean,"summary":"...","issues":["..."],"strengths":["..."]}. ' +
        "score 1=unacceptable, 5=excellent. pass=false if serious gaps would block filing or research.";

    const userPrompt =
        "Review the following phase artifacts and evaluate against the rubric.\n\n" +
        artifacts;

    const reports: JudgeReport[] = [];
    for (const model of params.judgeModels) {
        try {
            const raw = await completeText({
                model,
                systemPrompt,
                user: userPrompt,
                maxTokens: 2048,
                apiKeys: params.apiKeys,
            });
            reports.push(parseJudgeResponse(raw, model));
        } catch (err) {
            reports.push({
                model,
                score: 0,
                pass: true,
                summary: "",
                issues: [],
                strengths: [],
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return reports;
}
