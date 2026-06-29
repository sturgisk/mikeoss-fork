import fs from "fs";
import path from "path";
import type { ProcessDefinition } from "./types";

const CACHE = new Map<string, ProcessDefinition>();

function extensionsRoot(): string {
    const candidates = [
        path.join(process.cwd(), "extensions"),
        path.join(process.cwd(), "../extensions"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "litigation", "processes"))) {
            return candidate;
        }
    }
    throw new Error(
        "DSMB extensions root not found. Expected extensions/litigation/processes relative to repo or backend cwd.",
    );
}

function processesDir(): string {
    return path.join(extensionsRoot(), "litigation", "processes");
}

export function loadProcessDefinition(processId: string): ProcessDefinition {
    const cached = CACHE.get(processId);
    if (cached) return cached;
    const filePath = path.join(processesDir(), `${processId}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Process definition not found: ${processId}`);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProcessDefinition;
    CACHE.set(processId, raw);
    return raw;
}

export function listProcessDefinitions(): ProcessDefinition[] {
    const dir = processesDir();
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    return files.map((f) =>
        loadProcessDefinition(f.replace(/\.json$/, "")),
    );
}

export function applyVariantTemplate(
    template: string,
    variant: ProcessDefinition["variants"][number],
): string {
    return template
        .replace(/\{\{variant\.title\}\}/g, variant.title)
        .replace(/\{\{variant\.focus\}\}/g, variant.focus)
        .replace(/\{\{variant\.research_emphasis\}\}/g, variant.research_emphasis)
        .replace(/\{\{variant\.draft_template\}\}/g, variant.draft_template)
        .replace(/\{\{variant\.description\}\}/g, variant.description);
}
