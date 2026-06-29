"use client";

import { useEffect, useState } from "react";
import {
    listJudgeModels,
    type JudgeModelOption,
} from "@/dsmb/litigationApi";

const STORAGE_KEY = "dsmb-litigation-judge-models";

export function loadSavedJudgeModels(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((x) => typeof x === "string")
            : [];
    } catch {
        return [];
    }
}

export function saveJudgeModels(ids: string[]): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function JudgePicker({
    projectId,
    selected,
    onChange,
}: {
    projectId: string;
    selected: string[];
    onChange: (ids: string[]) => void;
}) {
    const [models, setModels] = useState<JudgeModelOption[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        listJudgeModels(projectId)
            .then(setModels)
            .catch(() => setModels([]))
            .finally(() => setLoading(false));
    }, [projectId]);

    function toggle(id: string) {
        if (selected.includes(id)) {
            onChange(selected.filter((x) => x !== id));
        } else if (selected.length < 5) {
            onChange([...selected, id]);
        }
    }

    if (loading) {
        return (
            <p className="text-sm text-gray-500">Loading judge models…</p>
        );
    }

    const available = models.filter((m) => m.available);

    return (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="text-sm font-medium text-gray-900">
                Judge models
            </h3>
            <p className="mt-1 text-xs text-gray-500">
                Pick up to 5 models to evaluate agent output at each human
                review step. Judges use a different provider than the Claude
                agent when possible.
            </p>
            {available.length === 0 ? (
                <p className="mt-3 text-sm text-amber-700">
                    No judge models available. Add Gemini or OpenAI keys in
                    Account → Models & API Keys (Anthropic can also judge, but
                    cross-provider review is recommended).
                </p>
            ) : (
                <ul className="mt-3 space-y-2">
                    {models.map((m) => (
                        <li key={m.id}>
                            <label
                                className={`flex cursor-pointer items-center gap-2 text-sm ${
                                    m.available
                                        ? "text-gray-800"
                                        : "cursor-not-allowed text-gray-400"
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.includes(m.id)}
                                    disabled={!m.available}
                                    onChange={() => toggle(m.id)}
                                    className="rounded border-gray-300"
                                />
                                <span>{m.label}</span>
                                {!m.available && (
                                    <span className="text-xs">(no key)</span>
                                )}
                            </label>
                        </li>
                    ))}
                </ul>
            )}
            {selected.length > 0 && (
                <p className="mt-2 text-xs text-gray-500">
                    Selected: {selected.join(", ")}
                </p>
            )}
        </div>
    );
}
