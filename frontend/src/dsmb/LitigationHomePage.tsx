"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
    JudgePicker,
    loadSavedJudgeModels,
    saveJudgeModels,
} from "@/dsmb/JudgePicker";
import {
    listLitigationProcesses,
    listLitigationRuns,
    startLitigationRun,
    type LitigationProcess,
    type ProcessRun,
} from "@/dsmb/litigationApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";

export function LitigationHomePage({ projectId }: { projectId: string }) {
    const router = useRouter();
    const { project } = useProjectWorkspace();
    const [processes, setProcesses] = useState<LitigationProcess[]>([]);
    const [runs, setRuns] = useState<ProcessRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [starting, setStarting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [judgeModels, setJudgeModels] = useState<string[]>(() =>
        loadSavedJudgeModels(),
    );

    useEffect(() => {
        saveJudgeModels(judgeModels);
    }, [judgeModels]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [p, r] = await Promise.all([
                listLitigationProcesses(projectId),
                listLitigationRuns(projectId),
            ]);
            setProcesses(p);
            setRuns(r);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    async function handleStart(processId: string, variantId: string) {
        setStarting(`${processId}:${variantId}`);
        setError(null);
        try {
            const run = await startLitigationRun(
                projectId,
                processId,
                variantId,
                judgeModels,
            );
            router.push(`/projects/${projectId}/litigation/runs/${run.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to start");
        } finally {
            setStarting(null);
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <ProjectSectionToolbar />
            <PageHeader
                title="Litigation"
                subtitle={
                    project?.name
                        ? `${project.name} — agent-driven workflows`
                        : "Agent-driven litigation workflows"
                }
            />
            <div className="flex-1 overflow-y-auto px-6 py-6">
                {error && (
                    <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                        {error}
                    </p>
                )}
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading processes…
                    </div>
                ) : (
                    <div className="space-y-8">
                        <JudgePicker
                            projectId={projectId}
                            selected={judgeModels}
                            onChange={setJudgeModels}
                        />
                        {processes.map((process) => (
                            <section key={process.id}>
                                <h2 className="text-lg font-medium text-gray-900">
                                    {process.title}
                                </h2>
                                <p className="mt-1 max-w-2xl text-sm text-gray-600">
                                    {process.description}
                                </p>
                                <div className="mt-4 grid gap-3 md:grid-cols-3">
                                    {process.variants.map((variant) => (
                                        <button
                                            key={variant.id}
                                            type="button"
                                            disabled={
                                                starting ===
                                                `${process.id}:${variant.id}`
                                            }
                                            onClick={() =>
                                                void handleStart(
                                                    process.id,
                                                    variant.id,
                                                )
                                            }
                                            className="rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-gray-300 hover:shadow disabled:opacity-60"
                                        >
                                            <div className="font-medium text-gray-900">
                                                {variant.title}
                                            </div>
                                            <p className="mt-2 text-sm text-gray-600">
                                                {variant.description}
                                            </p>
                                            {starting ===
                                                `${process.id}:${variant.id}` && (
                                                <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                    Starting…
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </section>
                        ))}

                        {runs.length > 0 && (
                            <section>
                                <h2 className="text-lg font-medium text-gray-900">
                                    Recent runs
                                </h2>
                                <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                                    {runs.map((run) => (
                                        <li key={run.id}>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    router.push(
                                                        `/projects/${projectId}/litigation/runs/${run.id}`,
                                                    )
                                                }
                                                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-gray-50"
                                            >
                                                <span>
                                                    {run.process_id} ·{" "}
                                                    {run.variant_id}
                                                </span>
                                                <span className="text-gray-500">
                                                    {run.status}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
