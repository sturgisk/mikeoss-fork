"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
    executeLitigationRunStream,
    getLitigationRun,
    listVaultFiles,
    readVaultFile,
    submitLitigationHitl,
    type PendingHitl,
    type ProcessRun,
} from "@/dsmb/litigationApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";

type DocxExportMeta = {
    filename?: string;
    download_url?: string;
    document_id?: string;
    message?: string;
};

export function LitigationRunPage({
    projectId,
    runId,
}: {
    projectId: string;
    runId: string;
}) {
    const [run, setRun] = useState<ProcessRun | null>(null);
    const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
    const [phaseTitle, setPhaseTitle] = useState<string | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [vaultPreview, setVaultPreview] = useState<string | null>(null);
    const [docxExport, setDocxExport] = useState<DocxExportMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [researchJson, setResearchJson] = useState("");
    const autoStartedRef = useRef(false);

    const refresh = useCallback(async () => {
        const data = await getLitigationRun(projectId, runId);
        setRun(data.run);
        setPendingHitl(data.pending_hitl);
        setPhaseTitle(data.current_phase?.title ?? null);
        const files = await listVaultFiles(projectId);
        const previewPath =
            files.find((f) => f.path === "drafts/mtd-draft.md")?.path ??
            files.find((f) => f.path === "analysis/claims-chart.md")?.path;
        if (previewPath) {
            setVaultPreview(await readVaultFile(projectId, previewPath));
        }
        const exportFile = files.find((f) => f.path === "drafts/mtd-export.json");
        if (exportFile) {
            try {
                const raw = await readVaultFile(projectId, exportFile.path);
                setDocxExport(JSON.parse(raw) as DocxExportMeta);
            } catch {
                setDocxExport(null);
            }
        }
        const proposed = files.find(
            (f) => f.path === "research/queries-proposed.json",
        );
        if (proposed) {
            setResearchJson(await readVaultFile(projectId, proposed.path));
        }
        return data.run;
    }, [projectId, runId]);

    const runPhaseStream = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            await executeLitigationRunStream(projectId, runId, (payload) => {
                if (payload.type === "agent_event") {
                    setLog((prev) => [
                        ...prev.slice(-40),
                        JSON.stringify(payload.event).slice(0, 500),
                    ]);
                }
                if (payload.type === "run_updated") {
                    setRun(payload.run as ProcessRun);
                }
                if (payload.type === "hitl_required") {
                    setPendingHitl(payload.pending_hitl as PendingHitl);
                }
                if (payload.type === "judge_reports") {
                    setPendingHitl((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  judge_reports: payload.reports as PendingHitl["judge_reports"],
                              }
                            : prev,
                    );
                }
                if (payload.type === "error") {
                    setError(String(payload.detail ?? "Execution failed"));
                }
            });
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Execution failed");
        } finally {
            setBusy(false);
        }
    }, [projectId, runId, refresh]);

    useEffect(() => {
        void refresh()
            .then((loadedRun) => {
                if (
                    loadedRun?.status === "pending" &&
                    !autoStartedRef.current
                ) {
                    autoStartedRef.current = true;
                    void runPhaseStream();
                }
            })
            .catch((err) =>
                setError(
                    err instanceof Error ? err.message : "Failed to load run",
                ),
            );
    }, [refresh, runPhaseStream]);

    async function submitHitl(
        decision: "approve" | "edit" | "reject" | "skip",
        payload?: Record<string, unknown>,
    ) {
        setBusy(true);
        setError(null);
        try {
            const result = await submitLitigationHitl(
                projectId,
                runId,
                decision,
                payload,
            );
            setRun(result.run);
            setPendingHitl(result.pending_hitl);
            if (
                result.run.status === "pending" &&
                (decision === "approve" ||
                    decision === "skip" ||
                    decision === "edit")
            ) {
                await runPhaseStream();
            } else {
                await refresh();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "HITL failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <ProjectSectionToolbar />
            <PageHeader
                title="Litigation run"
                subtitle={
                    phaseTitle
                        ? `${phaseTitle} · ${run?.status ?? "…"}`
                        : (run?.status ?? "Loading…")
                }
            />
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-6 lg:flex-row">
                <div className="min-w-0 flex-1 space-y-4">
                    {error && (
                        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                            {error}
                        </p>
                    )}

                    {busy && (
                        <div className="flex items-center gap-2 text-sm text-gray-600">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Running agent phases…
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                        {run?.status === "pending" && !busy && (
                            <button
                                type="button"
                                onClick={() => void runPhaseStream()}
                                className="rounded-md border border-gray-300 px-4 py-2 text-sm"
                            >
                                Retry current phase
                            </button>
                        )}
                        {run?.status === "awaiting_hitl" && pendingHitl && (
                            <>
                                {pendingHitl.gate.actions.includes("approve") && (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void submitHitl("approve")}
                                        className="rounded-md bg-green-700 px-4 py-2 text-sm text-white disabled:opacity-60"
                                    >
                                        Approve & continue
                                    </button>
                                )}
                                {pendingHitl.gate.actions.includes("skip") && (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void submitHitl("skip")}
                                        className="rounded-md border border-gray-300 px-4 py-2 text-sm disabled:opacity-60"
                                    >
                                        Skip & continue
                                    </button>
                                )}
                                {pendingHitl.gate.actions.includes("reject") && (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void submitHitl("reject")}
                                        className="rounded-md bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-60"
                                    >
                                        Reject
                                    </button>
                                )}
                            </>
                        )}
                    </div>

                    {pendingHitl && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                            <h3 className="font-medium text-amber-900">
                                Human review required
                            </h3>
                            <p className="mt-2 text-sm text-amber-800">
                                {pendingHitl.gate.prompt}
                            </p>
                            {pendingHitl.judge_reports &&
                                pendingHitl.judge_reports.length > 0 && (
                                    <div className="mt-4 space-y-3">
                                        <h4 className="text-sm font-medium text-amber-900">
                                            Judge panel
                                        </h4>
                                        {pendingHitl.judge_reports.map(
                                            (report) => (
                                                <div
                                                    key={report.model}
                                                    className="rounded border border-amber-100 bg-white p-3 text-sm"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="font-medium text-gray-900">
                                                            {report.model}
                                                        </span>
                                                        <span
                                                            className={
                                                                report.pass
                                                                    ? "text-green-700"
                                                                    : "text-red-700"
                                                            }
                                                        >
                                                            {report.error
                                                                ? "Error"
                                                                : report.pass
                                                                  ? "Pass"
                                                                  : "Flagged"}{" "}
                                                            · {report.score}/5
                                                        </span>
                                                    </div>
                                                    {report.error ? (
                                                        <p className="mt-1 text-xs text-red-600">
                                                            {report.error}
                                                        </p>
                                                    ) : (
                                                        <>
                                                            {report.summary && (
                                                                <p className="mt-2 text-gray-700">
                                                                    {
                                                                        report.summary
                                                                    }
                                                                </p>
                                                            )}
                                                            {report.issues
                                                                .length > 0 && (
                                                                <ul className="mt-2 list-disc pl-4 text-xs text-red-700">
                                                                    {report.issues.map(
                                                                        (
                                                                            issue,
                                                                            i,
                                                                        ) => (
                                                                            <li
                                                                                key={
                                                                                    i
                                                                                }
                                                                            >
                                                                                {
                                                                                    issue
                                                                                }
                                                                            </li>
                                                                        ),
                                                                    )}
                                                                </ul>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            ),
                                        )}
                                    </div>
                                )}
                            {pendingHitl.gate.id ===
                                "approve-research-queries" && (
                                <>
                                    <textarea
                                        className="mt-3 w-full rounded border border-amber-200 bg-white p-2 font-mono text-xs"
                                        rows={8}
                                        value={researchJson}
                                        onChange={(e) =>
                                            setResearchJson(e.target.value)
                                        }
                                    />
                                    <button
                                        type="button"
                                        disabled={busy}
                                        className="mt-2 rounded-md bg-amber-800 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                                        onClick={() => {
                                            try {
                                                const queries = JSON.parse(
                                                    researchJson,
                                                ) as unknown[];
                                                void submitHitl("edit", {
                                                    queries,
                                                });
                                            } catch {
                                                setError(
                                                    "Research queries must be valid JSON.",
                                                );
                                            }
                                        }}
                                    >
                                        Save edited queries & continue
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {log.length > 0 && (
                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                            <h3 className="text-sm font-medium text-gray-700">
                                Agent activity
                            </h3>
                            <pre className="mt-2 max-h-48 overflow-auto text-xs text-gray-600">
                                {log.join("\n")}
                            </pre>
                        </div>
                    )}
                </div>

                <aside className="w-full shrink-0 space-y-3 lg:w-96">
                    {docxExport?.download_url && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                            <h3 className="text-sm font-medium text-green-900">
                                Word export
                            </h3>
                            <p className="mt-1 text-sm text-green-800">
                                {docxExport.filename ?? "Motion document"}
                            </p>
                            <a
                                href={docxExport.download_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-block text-sm font-medium text-green-900 underline"
                            >
                                Download .docx
                            </a>
                        </div>
                    )}
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                        <h3 className="text-sm font-medium text-gray-900">
                            Matter vault preview
                        </h3>
                        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs text-gray-600">
                            {vaultPreview ?? "(No draft content yet)"}
                        </pre>
                    </div>
                </aside>
            </div>
        </div>
    );
}
