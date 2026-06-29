import crypto from "crypto";
import { createServerSupabase } from "../../lib/supabase";
import { downloadFile, uploadFile } from "../../lib/storage";

type Db = ReturnType<typeof createServerSupabase>;

export function vaultStorageKey(projectId: string, vaultPath: string): string {
    const normalized = vaultPath.replace(/^\/+/, "").replace(/\.\./g, "");
    return `dsmb/vault/${projectId}/${normalized}`;
}

function contentHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export async function listVaultFiles(
    projectId: string,
    db: Db = createServerSupabase(),
): Promise<{ path: string; updated_at: string }[]> {
    const { data, error } = await db
        .from("dsmb_matter_vault_files")
        .select("path, updated_at")
        .eq("project_id", projectId)
        .order("path", { ascending: true });
    if (error) throw error;
    return (data ?? []) as { path: string; updated_at: string }[];
}

export async function readVaultFile(
    projectId: string,
    vaultPath: string,
    db: Db = createServerSupabase(),
): Promise<string | null> {
    const pathNorm = vaultPath.replace(/^\/+/, "");
    const { data, error } = await db
        .from("dsmb_matter_vault_files")
        .select("storage_path")
        .eq("project_id", projectId)
        .eq("path", pathNorm)
        .maybeSingle();
    if (error) throw error;
    const storagePath = (data as { storage_path?: string | null } | null)
        ?.storage_path;
    if (!storagePath) return null;
    const bytes = await downloadFile(storagePath);
    if (!bytes) return null;
    return Buffer.from(bytes).toString("utf8");
}

export async function writeVaultFile(
    projectId: string,
    vaultPath: string,
    content: string,
    db: Db = createServerSupabase(),
): Promise<{ path: string; content_hash: string }> {
    const pathNorm = vaultPath.replace(/^\/+/, "");
    const key = vaultStorageKey(projectId, pathNorm);
    const hash = contentHash(content);
    const buf = Buffer.from(content, "utf8");
    await uploadFile(
        key,
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        "text/markdown; charset=utf-8",
    );
    const now = new Date().toISOString();
    const { error } = await db.from("dsmb_matter_vault_files").upsert(
        {
            project_id: projectId,
            path: pathNorm,
            storage_path: key,
            content_hash: hash,
            updated_at: now,
        },
        { onConflict: "project_id,path" },
    );
    if (error) throw error;
    return { path: pathNorm, content_hash: hash };
}

export async function ensureMatterClaudeMd(
    projectId: string,
    projectName: string,
    variantTitle: string,
    db: Db = createServerSupabase(),
): Promise<void> {
    const existing = await readVaultFile(projectId, "CLAUDE.md", db);
    if (existing?.trim()) return;
    const body =
        `# Matter: ${projectName}\n\n` +
        `## Active process\n` +
        `- Motion to Dismiss — ${variantTitle}\n\n` +
        `## Vault layout\n` +
        `- \`analysis/\` — claims charts, exhibit indexes\n` +
        `- \`research/\` — queries, memos, citations\n` +
        `- \`drafts/\` — outlines and motion drafts\n`;
    await writeVaultFile(projectId, "CLAUDE.md", body, db);
}
