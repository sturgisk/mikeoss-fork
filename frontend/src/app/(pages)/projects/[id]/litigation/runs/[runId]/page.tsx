"use client";

import { use } from "react";
import { LitigationRunPage } from "@/dsmb/LitigationRunPage";

export default function Page({
    params,
}: {
    params: Promise<{ id: string; runId: string }>;
}) {
    const { id, runId } = use(params);
    return <LitigationRunPage projectId={id} runId={runId} />;
}
