import type { Express } from "express";
import { litigationRouter } from "./litigation/routes";

/**
 * DSMB private extensions. Enabled when MIKE_EXTENSIONS includes "litigation".
 * Keeps upstream Mike merge surface to this single registration call.
 */
export function registerDsmbExtensions(app: Express): void {
    const enabled = (process.env.MIKE_EXTENSIONS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    if (enabled.includes("litigation")) {
        app.use("/projects/:projectId/litigation", litigationRouter);
        console.log("[dsmb] litigation extension registered");
    }
}
