export type HitlAction = "approve" | "edit" | "reject" | "skip";

export type HitlGateDefinition = {
    id: string;
    prompt: string;
    actions: HitlAction[];
};

export type ProcessPhaseDefinition = {
    id: string;
    title: string;
    type: "agent" | "review" | "research" | "draft" | "manual";
    agent_id?: string;
    hitl_after?: HitlGateDefinition[];
    next: string | null;
};

export type ProcessVariantDefinition = {
    id: string;
    title: string;
    description: string;
    focus: string;
    research_emphasis: string;
    draft_template: string;
};

export type AgentDefinition = {
    description: string;
    system_prompt: string;
    max_turns: number;
    /** IDs of subagents from `subagents` this phase agent may delegate to via the Agent tool. */
    subagents?: string[];
};

export type SubagentDefinition = AgentDefinition;

export type ProcessDefinition = {
    id: string;
    pack: string;
    title: string;
    description: string;
    variants: ProcessVariantDefinition[];
    phases: ProcessPhaseDefinition[];
    agents: Record<string, AgentDefinition>;
    subagents?: Record<string, SubagentDefinition>;
};

export type ProcessRunStatus =
    | "pending"
    | "running"
    | "awaiting_hitl"
    | "completed"
    | "failed"
    | "cancelled";

export type ProcessRunRow = {
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
    gate: HitlGateDefinition;
    context?: Record<string, unknown>;
    judge_reports?: JudgeReport[];
};

export type MikeBridgeContext = {
    projectId: string;
    userId: string;
    userEmail?: string | null;
    runId: string;
    variant: ProcessVariantDefinition;
};
