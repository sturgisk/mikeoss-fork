import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { checkProjectAccess } from "../../lib/access";
import { safeErrorLog, safeErrorMessage } from "../../lib/safeError";
import { listProcessDefinitions, loadProcessDefinition } from "./processDefinitions";
import {
    executeUntilBlocked,
    getPendingHitl,
    getProcessRun,
    startProcessRun,
    submitHitlDecision,
} from "./processEngine";
import { listVaultFiles, readVaultFile } from "./vault";
import { listJudgeModelOptions } from "./judgeModels";
import { getUserApiKeys } from "../../lib/userApiKeys";

export const litigationRouter = Router({ mergeParams: true });

// GET /projects/:projectId/litigation/judge-models
litigationRouter.get("/judge-models", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    try {
        const apiKeys = await getUserApiKeys(userId, db);
        res.json({ models: listJudgeModelOptions(apiKeys) });
    } catch (err) {
        console.error("[dsmb/litigation] judge-models", safeErrorLog(err));
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});

// GET /projects/:projectId/litigation/processes
litigationRouter.get("/processes", requireAuth, (_req, res) => {
    try {
        const processes = listProcessDefinitions().map((p) => ({
            id: p.id,
            pack: p.pack,
            title: p.title,
            description: p.description,
            variants: p.variants.map((v) => ({
                id: v.id,
                title: v.title,
                description: v.description,
            })),
            phases: p.phases.map((ph) => ({
                id: ph.id,
                title: ph.title,
            })),
        }));
        res.json({ processes });
    } catch (err) {
        console.error("[dsmb/litigation] list processes", safeErrorLog(err));
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});

// GET /projects/:projectId/litigation/runs
litigationRouter.get("/runs", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
        .from("dsmb_process_runs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ runs: data ?? [] });
});

// POST /projects/:projectId/litigation/runs
litigationRouter.post("/runs", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId } = req.params;
    const { process_id, variant_id, judge_models } = req.body as {
        process_id?: string;
        variant_id?: string;
        judge_models?: string[];
    };
    if (!process_id?.trim() || !variant_id?.trim()) {
        return void res
            .status(400)
            .json({ detail: "process_id and variant_id are required" });
    }

    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data: project } = await db
        .from("projects")
        .select("name")
        .eq("id", projectId)
        .single();

    try {
        loadProcessDefinition(process_id);
        const run = await startProcessRun({
            projectId,
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            processId: process_id,
            variantId: variant_id,
            projectName: (project as { name?: string })?.name ?? "Matter",
            judgeModels: judge_models,
        });
        res.status(201).json({ run });
    } catch (err) {
        console.error("[dsmb/litigation] start run", safeErrorLog(err));
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});

// GET /projects/:projectId/litigation/runs/:runId
litigationRouter.get("/runs/:runId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId, runId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const run = await getProcessRun(runId, db);
    if (!run || run.project_id !== projectId) {
        return void res.status(404).json({ detail: "Run not found" });
    }

    const pending_hitl = await getPendingHitl(run);
    const definition = loadProcessDefinition(run.process_id);
    const phase = definition.phases.find((p) => p.id === run.current_phase_id);

    res.json({
        run,
        pending_hitl,
        current_phase: phase ?? null,
    });
});

// POST /projects/:projectId/litigation/runs/:runId/execute — SSE stream
litigationRouter.post("/runs/:runId/execute", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId, runId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
        const run = await executeUntilBlocked({
            runId,
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            abortSignal: abortController.signal,
            onEvent: (event) => write({ type: "agent_event", event }),
            onPhaseComplete: async (updated) => {
                write({ type: "run_updated", run: updated });
                if (updated.status === "awaiting_hitl") {
                    const pending = await getPendingHitl(updated);
                    if (pending) {
                        write({
                            type: "hitl_required",
                            pending_hitl: pending,
                        });
                    }
                }
            },
        });
        write({ type: "run_updated", run });
        const pending = await getPendingHitl(run);
        if (pending) write({ type: "hitl_required", pending_hitl: pending });
        write({ type: "done" });
        res.end();
    } catch (err) {
        console.error("[dsmb/litigation] execute", safeErrorLog(err));
        write({ type: "error", detail: safeErrorMessage(err) });
        res.end();
    }
});

// POST /projects/:projectId/litigation/runs/:runId/hitl
litigationRouter.post("/runs/:runId/hitl", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId, runId } = req.params;
    const { decision, payload } = req.body as {
        decision?: "approve" | "edit" | "reject" | "skip";
        payload?: Record<string, unknown>;
    };
    if (!decision) {
        return void res.status(400).json({ detail: "decision is required" });
    }

    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const existing = await getProcessRun(runId, db);
    if (!existing || existing.project_id !== projectId) {
        return void res.status(404).json({ detail: "Run not found" });
    }

    try {
        const run = await submitHitlDecision({
            runId,
            userId,
            decision,
            payload,
        });
        res.json({ run, pending_hitl: await getPendingHitl(run) });
    } catch (err) {
        console.error("[dsmb/litigation] hitl", safeErrorLog(err));
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});

// GET /projects/:projectId/litigation/vault
litigationRouter.get("/vault", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    try {
        const files = await listVaultFiles(projectId, db);
        res.json({ files });
    } catch (err) {
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});

// GET /projects/:projectId/litigation/vault/file?path=analysis/claims-chart.md
litigationRouter.get("/vault/file", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { projectId } = req.params;
    const vaultPath = String(req.query.path ?? "").trim();
    if (!vaultPath) return void res.status(400).json({ detail: "path query required" });

    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        userId,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    try {
        const content = await readVaultFile(projectId, vaultPath, db);
        if (content == null) return void res.status(404).json({ detail: "Not found" });
        res.json({ path: vaultPath, content });
    } catch (err) {
        res.status(500).json({ detail: safeErrorMessage(err) });
    }
});
