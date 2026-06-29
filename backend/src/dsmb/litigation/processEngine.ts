import { createServerSupabase } from "../../lib/supabase";
import { loadProcessDefinition } from "./processDefinitions";
import {
    buildPhasePrompt,
    runLitigationAgentPhase,
} from "./agentRunner";
import type {
    HitlGateDefinition,
    PendingHitl,
    ProcessRunRow,
} from "./types";
import { ensureMatterClaudeMd, readVaultFile, writeVaultFile } from "./vault";
import { runPhaseJudges } from "./judge";
import { validateJudgeModels } from "./judgeModels";
import { getUserApiKeys } from "../../lib/userApiKeys";
import type { JudgeReport } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

async function appendRunEvent(
    db: Db,
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
): Promise<number> {
    const { data: last } = await db
        .from("dsmb_process_run_events")
        .select("seq")
        .eq("run_id", runId)
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
    const seq = ((last as { seq?: number } | null)?.seq ?? 0) + 1;
    const { error } = await db.from("dsmb_process_run_events").insert({
        run_id: runId,
        seq,
        event_type: eventType,
        payload,
    });
    if (error) throw error;
    return seq;
}

async function updateRun(
    db: Db,
    runId: string,
    patch: Partial<ProcessRunRow>,
): Promise<ProcessRunRow> {
    const { data, error } = await db
        .from("dsmb_process_runs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", runId)
        .select("*")
        .single();
    if (error || !data) throw error ?? new Error("Run not found");
    return normalizeRunRow(data as Record<string, unknown>);
}

function getPhase(definition: ReturnType<typeof loadProcessDefinition>, phaseId: string) {
    const phase = definition.phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
    return phase;
}

function pendingHitlFromPhase(
    phaseId: string,
    gate: HitlGateDefinition,
    context?: Record<string, unknown>,
    judgeReports?: JudgeReport[],
): PendingHitl {
    return { phase_id: phaseId, gate, context, judge_reports: judgeReports };
}

export async function startProcessRun(params: {
    projectId: string;
    userId: string;
    userEmail?: string | null;
    processId: string;
    variantId: string;
    projectName: string;
    judgeModels?: string[];
}): Promise<ProcessRunRow> {
    const db = createServerSupabase();
    const apiKeys = await getUserApiKeys(params.userId, db);
    const judgeModels = validateJudgeModels(
        params.judgeModels ?? [],
        apiKeys,
    );
    const definition = loadProcessDefinition(params.processId);
    const variant = definition.variants.find((v) => v.id === params.variantId);
    if (!variant) throw new Error(`Unknown variant: ${params.variantId}`);
    const firstPhase = definition.phases[0];
    if (!firstPhase) throw new Error("Process has no phases");

    await ensureMatterClaudeMd(
        params.projectId,
        params.projectName,
        variant.title,
        db,
    );

    const { data, error } = await db
        .from("dsmb_process_runs")
        .insert({
            project_id: params.projectId,
            user_id: params.userId,
            process_id: params.processId,
            variant_id: params.variantId,
            status: "pending",
            current_phase_id: firstPhase.id,
            phase_state: {},
            judge_models: judgeModels,
        })
        .select("*")
        .single();
    if (error || !data) throw error ?? new Error("Failed to create run");
    const run = normalizeRunRow(data as Record<string, unknown>);
    await appendRunEvent(db, run.id, "run_started", {
        process_id: params.processId,
        variant_id: params.variantId,
    });
    return run;
}

export async function getProcessRun(
    runId: string,
    db: Db = createServerSupabase(),
): Promise<ProcessRunRow | null> {
    const { data } = await db
        .from("dsmb_process_runs")
        .select("*")
        .eq("id", runId)
        .maybeSingle();
    if (!data) return null;
    return normalizeRunRow(data as Record<string, unknown>);
}

function normalizeRunRow(raw: Record<string, unknown>): ProcessRunRow {
    return {
        ...(raw as ProcessRunRow),
        judge_models: Array.isArray(raw.judge_models)
            ? (raw.judge_models as string[])
            : [],
        phase_state:
            raw.phase_state && typeof raw.phase_state === "object"
                ? (raw.phase_state as Record<string, unknown>)
                : {},
    };
}

export async function getPendingHitl(
    run: ProcessRunRow,
): Promise<PendingHitl | null> {
    if (run.status !== "awaiting_hitl" || !run.current_phase_id) return null;
    const definition = loadProcessDefinition(run.process_id);
    const phase = getPhase(definition, run.current_phase_id);
    const state = run.phase_state as {
        pending_gate_id?: string;
        hitl_context?: Record<string, unknown>;
        judge_reports?: JudgeReport[];
    };
    const gateId = state.pending_gate_id;
    if (!gateId) return null;
    const gate = phase.hitl_after?.find((g) => g.id === gateId);
    if (!gate) return null;
    const judgeReports = state.judge_reports as JudgeReport[] | undefined;
    return pendingHitlFromPhase(phase.id, gate, state.hitl_context, judgeReports);
}

export async function executeCurrentPhase(params: {
    runId: string;
    userId: string;
    userEmail?: string | null;
    onEvent?: (event: unknown) => void | Promise<void>;
    abortSignal?: AbortSignal;
}): Promise<ProcessRunRow> {
    const db = createServerSupabase();
    let run = await getProcessRun(params.runId, db);
    if (!run) throw new Error("Run not found");
    if (run.user_id !== params.userId) throw new Error("Forbidden");
    if (run.status === "completed" || run.status === "cancelled") return run;
    if (run.status === "awaiting_hitl") {
        throw new Error("Run is awaiting human review. Submit HITL decision first.");
    }

    const definition = loadProcessDefinition(run.process_id);
    const variant = definition.variants.find((v) => v.id === run!.variant_id);
    if (!variant) throw new Error("Variant not found");
    const phaseId = run.current_phase_id;
    if (!phaseId) throw new Error("Run has no current phase");
    const phase = getPhase(definition, phaseId);

    run = await updateRun(db, run.id, { status: "running" });
    await appendRunEvent(db, run.id, "phase_started", {
        phase_id: phase.id,
        title: phase.title,
    });

    try {
        if (phase.type === "agent" && phase.agent_id) {
            const agent = definition.agents[phase.agent_id];
            if (!agent) throw new Error(`Unknown agent: ${phase.agent_id}`);
            const state = run.phase_state as {
                hitl_payload?: Record<string, unknown>;
            };
            const phasePrompt = buildPhasePrompt({
                phaseTitle: phase.title,
                variant,
                hitlContext: state.hitl_payload,
            });
            const result = await runLitigationAgentPhase({
                ctx: {
                    projectId: run.project_id,
                    userId: params.userId,
                    userEmail: params.userEmail,
                    runId: run.id,
                    variant,
                },
                agent,
                process: definition,
                variant,
                phasePrompt,
                onEvent: async (event) => {
                    await appendRunEvent(db, run!.id, "agent_message", {
                        event,
                    });
                    await params.onEvent?.(event);
                },
                abortSignal: params.abortSignal,
            });
            const phaseState = {
                ...(run.phase_state as Record<string, unknown>),
                [`${phase.id}_transcript`]: result.transcript,
            };
            run = await updateRun(db, run.id, { phase_state: phaseState });
            await appendRunEvent(db, run.id, "phase_completed", {
                phase_id: phase.id,
                transcript_preview: result.transcript.slice(0, 2000),
            });
        }

        const gate = phase.hitl_after?.[0];
        if (gate) {
            let judgeReports: JudgeReport[] = [];
            const judgeModels = (
                Array.isArray((run as ProcessRunRow).judge_models)
                    ? (run as ProcessRunRow).judge_models
                    : []
            ) as string[];
            if (judgeModels.length) {
                const apiKeys = await getUserApiKeys(params.userId, db);
                judgeReports = await runPhaseJudges({
                    projectId: run.project_id,
                    phase,
                    judgeModels,
                    transcript: (run.phase_state as Record<string, unknown>)[
                        `${phase.id}_transcript`
                    ] as string | undefined,
                    apiKeys,
                    db,
                });
                await appendRunEvent(db, run.id, "judge_reports", {
                    phase_id: phase.id,
                    reports: judgeReports,
                });
            }
            run = await updateRun(db, run.id, {
                status: "awaiting_hitl",
                phase_state: {
                    ...(run.phase_state as Record<string, unknown>),
                    pending_gate_id: gate.id,
                    judge_reports: judgeReports,
                    hitl_context: {
                        phase_id: phase.id,
                        transcript: (run.phase_state as Record<string, unknown>)[
                            `${phase.id}_transcript`
                        ],
                    },
                },
            });
            await appendRunEvent(db, run.id, "hitl_required", {
                phase_id: phase.id,
                gate,
                judge_reports: judgeReports,
            });
            return run;
        }

        return await advanceToNextPhase(run, db);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run = await updateRun(db, run.id, {
            status: "failed",
            error_message: message,
        });
        await appendRunEvent(db, run.id, "run_failed", { error: message });
        throw err;
    }
}

const MAX_AUTO_PHASES = 20;

/** Run consecutive pending phases until HITL, completion, failure, or cap. */
export async function executeUntilBlocked(params: {
    runId: string;
    userId: string;
    userEmail?: string | null;
    onEvent?: (event: unknown) => void | Promise<void>;
    onPhaseComplete?: (run: ProcessRunRow) => void | Promise<void>;
    abortSignal?: AbortSignal;
}): Promise<ProcessRunRow> {
    let run = await getProcessRun(params.runId);
    if (!run) throw new Error("Run not found");
    if (run.user_id !== params.userId) throw new Error("Forbidden");

    let iterations = 0;
    while (
        run.status === "pending" &&
        iterations < MAX_AUTO_PHASES &&
        !params.abortSignal?.aborted
    ) {
        iterations++;
        run = await executeCurrentPhase(params);
        await params.onPhaseComplete?.(run);
        if (
            run.status === "awaiting_hitl" ||
            run.status === "completed" ||
            run.status === "failed" ||
            run.status === "cancelled"
        ) {
            break;
        }
    }
    return run;
}

async function advanceToNextPhase(
    run: ProcessRunRow,
    db: Db,
): Promise<ProcessRunRow> {
    const definition = loadProcessDefinition(run.process_id);
    const phase = getPhase(definition, run.current_phase_id!);
    const nextId = phase.next;
    if (!nextId) {
        return updateRun(db, run.id, {
            status: "completed",
            phase_state: {
                ...(run.phase_state as Record<string, unknown>),
                pending_gate_id: undefined,
            },
        });
    }
    return updateRun(db, run.id, {
        status: "pending",
        current_phase_id: nextId,
        phase_state: {
            ...(run.phase_state as Record<string, unknown>),
            pending_gate_id: undefined,
            hitl_payload: undefined,
        },
    });
}

export async function submitHitlDecision(params: {
    runId: string;
    userId: string;
    decision: "approve" | "edit" | "reject" | "skip";
    payload?: Record<string, unknown>;
}): Promise<ProcessRunRow> {
    const db = createServerSupabase();
    let run = await getProcessRun(params.runId, db);
    if (!run) throw new Error("Run not found");
    if (run.user_id !== params.userId) throw new Error("Forbidden");
    if (run.status !== "awaiting_hitl") {
        throw new Error("Run is not awaiting human review.");
    }

    const pending = await getPendingHitl(run);
    if (!pending) throw new Error("No pending HITL gate.");

    if (params.decision === "reject") {
        return updateRun(db, run.id, {
            status: "failed",
            error_message: "Process rejected at human review step.",
        });
    }

    await db.from("dsmb_hitl_decisions").insert({
        run_id: run.id,
        phase_id: pending.phase_id,
        gate_id: pending.gate.id,
        decision: params.decision,
        payload: params.payload ?? {},
        user_id: params.userId,
    });

    await appendRunEvent(db, run.id, "hitl_decision", {
        gate_id: pending.gate.id,
        decision: params.decision,
        payload: params.payload ?? {},
    });

    if (pending.gate.id === "approve-research-queries") {
        const edited =
            (params.payload?.queries as unknown[]) ??
            (params.payload?.approved_queries as unknown[]);
        if (Array.isArray(edited) && edited.length) {
            await writeVaultFile(
                run.project_id,
                "research/queries-approved.json",
                JSON.stringify(edited, null, 2),
                db,
            );
        } else if (
            params.decision === "approve" ||
            params.decision === "skip"
        ) {
            const proposed = await readVaultFile(
                run.project_id,
                "research/queries-proposed.json",
                db,
            );
            if (proposed) {
                await writeVaultFile(
                    run.project_id,
                    "research/queries-approved.json",
                    proposed,
                    db,
                );
            }
        }
    }

    if (params.decision === "edit") {
        const advanceAfterEdit =
            pending.gate.id === "approve-research-queries" &&
            (params.payload?.queries ?? params.payload?.approved_queries);
        if (advanceAfterEdit) {
            run = await updateRun(db, run.id, {
                phase_state: {
                    ...(run.phase_state as Record<string, unknown>),
                    pending_gate_id: undefined,
                    hitl_payload: params.payload ?? {},
                },
            });
            return advanceToNextPhase(run, db);
        }
        return updateRun(db, run.id, {
            status: "pending",
            phase_state: {
                ...(run.phase_state as Record<string, unknown>),
                pending_gate_id: undefined,
                hitl_payload: params.payload ?? {},
            },
        });
    }

    run = await updateRun(db, run.id, {
        phase_state: {
            ...(run.phase_state as Record<string, unknown>),
            pending_gate_id: undefined,
            hitl_payload: params.payload ?? {},
        },
    });
    return advanceToNextPhase(run, db);
}
