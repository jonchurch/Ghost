export interface Pagination {
    page: number;
    pages: number;
    limit: number | 'all';
    total: number;
    prev: number | null;
    next: number | null;
}

export interface Page<T> {
    data: T[];
    meta: {
        pagination: Pagination;
    };
}

export interface WaitAction {
    id: string;
    type: 'wait';
    data: {
        wait_hours: number;
    };
}

export interface SendEmailAction {
    id: string;
    type: 'send_email';
    data: {
        email_subject: string;
        email_lexical: string;
        email_sender_name: string | null;
        email_sender_email: string | null;
        email_sender_reply_to: string | null;
        email_design_setting_id: string;
    };
}

export type AutomationAction = WaitAction | SendEmailAction;

export interface AutomationEdge {
    source_action_id: string;
    target_action_id: string;
}

export interface AutomationSummary {
    id: string;
    slug: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface Automation extends AutomationSummary {
    actions: AutomationAction[];
    edges: AutomationEdge[];
}

export interface EditAutomationData {
    status: string;
    actions: AutomationAction[];
    edges: AutomationEdge[];
}

export type AutomationStepTerminalStatus =
    | 'automation disabled'
    | 'email send failed'
    | 'finished'
    | 'member changed status'
    | 'member unsubscribed';

type AutomationStepBase = {
    id: string;
    locked_by: string;
    automation_run_id: string;
    automation_id: string;
    automation_slug: string;
    automation_status: string;
    member_id: string | null;
    member_email: string;
    action_id: string;
    automation_action_revision_id: string;
    ready_at: Date;
    step_attempts: number;
};

export type AutomationStepToRun = AutomationStepBase & (
    {
        type: 'wait';
        wait_hours: number;
    } | {
        type: 'send_email';
        email_subject: string;
        email_lexical: string;
        email_sender_name: string | null;
        email_sender_email: string | null;
        email_sender_reply_to: string | null;
        email_design_setting_id: string | null;
    }
);

export interface AutomationsRepository {
    browse(): Promise<Page<AutomationSummary>>;
    getById(id: string): Promise<Automation | null>;
    edit(id: string, data: EditAutomationData): Promise<Automation | null>;
    enqueueRun(data: {
        memberEmail: string;
        memberId: string;
        slug: string;
    }): Promise<{id: string} | null>;
    fetchAndLockSteps(limit: number): Promise<{
        steps: AutomationStepToRun[],
        nextStepReadyAt: null;
    } | {
        steps: never[],
        nextStepReadyAt: null | Date;
    }>;
    finishStepAndEnqueueNext(step: AutomationStepToRun): Promise<Date | null>;
    markStepTerminal(step: AutomationStepToRun, status: AutomationStepTerminalStatus): Promise<boolean>;
    retryStep(step: AutomationStepToRun, retryAt: Date): Promise<boolean>;
}
