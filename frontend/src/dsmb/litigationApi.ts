import { supabase } from "@/lib/supabase";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function getAuthHeader(): Promise<Record<string, string>> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...init,
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...authHeaders,
            ...(init?.headers ?? {}),
        },
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
            detail?: string;
        } | null;
        throw new Error(body?.detail ?? `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
}

export type LitigationProcessVariant = {
    id: string;
    title: string;
    description: string;
};

export type LitigationProcess = {
    id: string;
    pack: string;
    title: string;
    description: string;
    variants: LitigationProcessVariant[];
    phases: { id: string; title: string }[];
};

export type ProcessRunStatus =
    | "pending"
    | "running"
    | "awaiting_hitl"
    | "completed"
    | "failed"
    | "cancelled";

export type ProcessRun = {
    id: string;
    project_id: string;
    user_id: string;
    process_id: string;
    variant_id: string;
    status: ProcessRunStatus;
    current_phase_id: string | null;
    phase_state: Record<string, unknown>;
    judge_models: string[];
    error_message: string | null;
    created_at: string;
    updated_at: string;
};

export type JudgeModelOption = {
    id: string;
    label: string;
    provider: "claude" | "gemini" | "openai";
    available: boolean;
};

export type JudgeReport = {
    model: string;
    score: number;
    pass: boolean;
    summary: string;
    issues: string[];
    strengths: string[];
    error?: string;
};

export type PendingHitl = {
    phase_id: string;
    gate: {
        id: string;
        prompt: string;
        actions: ("approve" | "edit" | "reject" | "skip")[];
    };
    context?: Record<string, unknown>;
    judge_reports?: JudgeReport[];
};

export async function listJudgeModels(
    projectId: string,
): Promise<JudgeModelOption[]> {
    const res = await apiFetch<{ models: JudgeModelOption[] }>(
        `/projects/${projectId}/litigation/judge-models`,
    );
    return res.models;
}

export async function listLitigationProcesses(
    projectId: string,
): Promise<LitigationProcess[]> {
    const res = await apiFetch<{ processes: LitigationProcess[] }>(
        `/projects/${projectId}/litigation/processes`,
    );
    return res.processes;
}

export async function listLitigationRuns(
    projectId: string,
): Promise<ProcessRun[]> {
    const res = await apiFetch<{ runs: ProcessRun[] }>(
        `/projects/${projectId}/litigation/runs`,
    );
    return res.runs;
}

export async function startLitigationRun(
    projectId: string,
    processId: string,
    variantId: string,
    judgeModels?: string[],
): Promise<ProcessRun> {
    const res = await apiFetch<{ run: ProcessRun }>(
        `/projects/${projectId}/litigation/runs`,
        {
            method: "POST",
            body: JSON.stringify({
                process_id: processId,
                variant_id: variantId,
                judge_models: judgeModels ?? [],
            }),
        },
    );
    return res.run;
}

export async function getLitigationRun(
    projectId: string,
    runId: string,
): Promise<{
    run: ProcessRun;
    pending_hitl: PendingHitl | null;
    current_phase: { id: string; title: string } | null;
}> {
    return apiFetch(`/projects/${projectId}/litigation/runs/${runId}`);
}

export async function submitLitigationHitl(
    projectId: string,
    runId: string,
    decision: "approve" | "edit" | "reject" | "skip",
    payload?: Record<string, unknown>,
): Promise<{ run: ProcessRun; pending_hitl: PendingHitl | null }> {
    return apiFetch(`/projects/${projectId}/litigation/runs/${runId}/hitl`, {
        method: "POST",
        body: JSON.stringify({ decision, payload }),
    });
}

export async function executeLitigationRunStream(
    projectId: string,
    runId: string,
    onEvent: (payload: Record<string, unknown>) => void,
): Promise<void> {
    const base = API_BASE;
    const res = await fetch(
        `${base}/projects/${projectId}/litigation/runs/${runId}/execute`,
        {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
        },
    );
    if (!res.ok || !res.body) {
        throw new Error(`Execute failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
                onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
            } catch {
                // ignore malformed chunks
            }
        }
    }
}

export async function listVaultFiles(
    projectId: string,
): Promise<{ path: string; updated_at: string }[]> {
    const res = await apiFetch<{ files: { path: string; updated_at: string }[] }>(
        `/projects/${projectId}/litigation/vault`,
    );
    return res.files;
}

export async function readVaultFile(
    projectId: string,
    path: string,
): Promise<string> {
    const res = await apiFetch<{ content: string }>(
        `/projects/${projectId}/litigation/vault/file?path=${encodeURIComponent(path)}`,
    );
    return res.content;
}
