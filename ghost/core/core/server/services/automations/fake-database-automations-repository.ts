import errors from '@tryghost/errors';
import tpl from '@tryghost/tpl';
import crypto from 'node:crypto';
import ObjectId from 'bson-objectid';
import type {DatabaseSync} from 'node:sqlite';
import type {
    Automation,
    AutomationAction,
    AutomationEdge,
    AutomationSummary,
    AutomationStepTerminalStatus,
    AutomationStepToRun,
    AutomationsRepository,
    EditAutomationData,
    Page
} from './automations-repository';

const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const messages = {
    invalidAutomationActionRevision: 'Automation action "{actionId}" of type "{actionType}" is missing required revision field "{field}".',
    conflictingAutomationActionId: 'Automation action "{actionId}" already exists and cannot be inserted.',
    conflictingAutomationActionType: 'Automation action "{actionId}" already exists with a different type.'
};

interface AutomationRow {
    id: string;
    slug: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
}

interface ActionRow {
    id: string;
    type: 'wait' | 'send_email';
    wait_hours: number | null;
    email_subject: string | null;
    email_lexical: string | null;
    email_sender_name: string | null;
    email_sender_email: string | null;
    email_sender_reply_to: string | null;
    email_design_setting_id: string | null;
}

interface EdgeRow {
    source_action_id: string;
    target_action_id: string;
}

type StepRow = {
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
    type: 'wait' | 'send_email';
    ready_at: string;
    step_attempts: number;
    wait_hours: number | null;
    email_subject: string | null;
    email_lexical: string | null;
    email_sender_name: string | null;
    email_sender_email: string | null;
    email_sender_reply_to: string | null;
    email_design_setting_id: string | null;
};

type NextActionRevisionRow = {
    automation_id?: string;
    action_id: string;
    automation_action_revision_id: string;
    type: 'wait' | 'send_email';
    wait_hours: number | null;
};

export function createFakeDatabaseAutomationsRepository({
    getDatabase
}: {
    getDatabase: () => DatabaseSync;
}): AutomationsRepository {
    return {
        async browse(): Promise<Page<AutomationSummary>> {
            const database = getDatabase();

            return withTransaction(database, () => {
                const rows = loadAutomations(database).map(row => buildAutomationSummary(row));

                return {
                    data: rows,
                    meta: {
                        pagination: buildPagination(rows.length)
                    }
                };
            });
        },

        async getById(id: string): Promise<Automation | null> {
            const database = getDatabase();
            return withTransaction(database, () => {
                const automation = loadAutomation(database, id);

                if (!automation) {
                    return null;
                }

                return buildAutomation(database, automation);
            });
        },

        async edit(id: string, data: EditAutomationData): Promise<Automation | null> {
            const database = getDatabase();

            return withTransaction(database, () => {
                const automation = loadAutomation(database, id);

                if (!automation) {
                    return null;
                }

                const updatedAutomation = updateAutomation(database, {
                    ...automation,
                    status: data.status,
                    updated_at: new Date().toISOString()
                });

                replaceAutomationGraph(database, updatedAutomation.id, data.actions, data.edges);

                return buildAutomation(database, updatedAutomation);
            });
        },

        async enqueueRun(data: {
            memberEmail: string;
            memberId: string;
            slug: string;
        }): Promise<void> {
            const database = getDatabase();

            return withTransaction(database, () => enqueueRun(database, data));
        },

        async fetchAndLockSteps(limit: number): Promise<{
            steps: AutomationStepToRun[],
            nextStepReadyAt: null;
        } | {
            steps: never[],
            nextStepReadyAt: null | Date;
        }> {
            const database = getDatabase();

            return withTransaction(database, () => fetchAndLockSteps(database, limit));
        },

        async finishStepAndEnqueueNext(step: AutomationStepToRun): Promise<Date | null> {
            const database = getDatabase();

            return withTransaction(database, () => finishStepAndEnqueueNext(database, step));
        },

        async markStepTerminal(step: AutomationStepToRun, status: AutomationStepTerminalStatus): Promise<boolean> {
            const database = getDatabase();

            return withTransaction(database, () => markStepTerminal(database, step, status));
        },

        async retryStep(step: AutomationStepToRun, retryAt: Date): Promise<boolean> {
            const database = getDatabase();

            return withTransaction(database, () => retryStep(database, step, retryAt));
        }
    };
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec('BEGIN TRANSACTION');

    try {
        const result = operation();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

function fetchAndLockSteps(database: DatabaseSync, limit: number): {
    steps: AutomationStepToRun[],
    nextStepReadyAt: null;
} | {
    steps: never[],
    nextStepReadyAt: null | Date;
} {
    const now = new Date();
    const nowString = now.toISOString();
    const staleLockCutoff = new Date(now.getTime() - LOCK_TIMEOUT_MS).toISOString();
    const lockId = crypto.randomUUID();

    const candidates = database.prepare(`
        SELECT id
        FROM automation_run_steps
        WHERE status = 'pending'
            AND ready_at <= ?
            AND (
                locked_by IS NULL
                OR locked_at < ?
            )
        ORDER BY ready_at, created_at, id
        LIMIT ?
    `).all(nowString, staleLockCutoff, limit) as unknown as Array<{id: string}>;

    const candidateIds = candidates.map(candidate => candidate.id);

    if (candidateIds.length === 0) {
        return {
            steps: [],
            nextStepReadyAt: findNextPendingReadyAt(database, nowString)
        };
    }

    const placeholders = candidateIds.map(() => '?').join(', ');

    database.prepare(`
        UPDATE automation_run_steps
        SET locked_by = ?,
            locked_at = ?,
            started_at = ?,
            finished_at = NULL,
            updated_at = ?,
            step_attempts = step_attempts + 1
        WHERE id IN (${placeholders})
            AND status = 'pending'
            AND ready_at <= ?
            AND (
                locked_by IS NULL
                OR locked_at < ?
            )
    `).run(lockId, nowString, nowString, nowString, ...candidateIds, nowString, staleLockCutoff);

    const rows = database.prepare(`
        SELECT
            step.id AS id,
            step.locked_by AS locked_by,
            step.automation_run_id AS automation_run_id,
            run.automation_id AS automation_id,
            automation.slug AS automation_slug,
            automation.status AS automation_status,
            run.member_id AS member_id,
            run.member_email AS member_email,
            action.id AS action_id,
            revision.id AS automation_action_revision_id,
            action.type AS type,
            step.ready_at AS ready_at,
            step.step_attempts AS step_attempts,
            revision.wait_hours AS wait_hours,
            revision.email_subject AS email_subject,
            revision.email_lexical AS email_lexical,
            revision.email_sender_name AS email_sender_name,
            revision.email_sender_email AS email_sender_email,
            revision.email_sender_reply_to AS email_sender_reply_to,
            revision.email_design_setting_id AS email_design_setting_id
        FROM automation_run_steps step
        INNER JOIN automation_runs run ON run.id = step.automation_run_id
        INNER JOIN automations automation ON automation.id = run.automation_id
        INNER JOIN automation_action_revisions revision ON revision.id = step.automation_action_revision_id
        INNER JOIN automation_actions action ON action.id = revision.action_id
        WHERE step.id IN (${placeholders})
            AND step.status = 'pending'
            AND step.locked_by = ?
        ORDER BY step.ready_at, step.created_at, step.id
    `).all(...candidateIds, lockId) as unknown as StepRow[];

    if (rows.length === 0) {
        return {
            steps: [],
            nextStepReadyAt: findNextPendingReadyAt(database, nowString)
        };
    }

    return {
        steps: rows.map(row => buildStepToRun(row)),
        nextStepReadyAt: null
    };
}

function enqueueRun(database: DatabaseSync, {
    memberEmail,
    memberId,
    slug
}: {
    memberEmail: string;
    memberId: string;
    slug: string;
}): void {
    const firstAction = findFirstActionRevision(database, slug);

    if (!firstAction?.automation_id) {
        return;
    }

    const now = new Date();
    const nowString = now.toISOString();
    const readyAt = getReadyAtForAction(firstAction, now);
    const run = {
        id: ObjectId().toHexString(),
        created_at: nowString,
        updated_at: nowString,
        automation_id: firstAction.automation_id,
        member_id: memberId,
        member_email: memberEmail
    };

    database.prepare(`
        INSERT INTO automation_runs
        (id, created_at, updated_at, automation_id, member_id, member_email) VALUES
        (:id, :created_at, :updated_at, :automation_id, :member_id, :member_email)
    `).run(run);

    database.prepare(`
        INSERT INTO automation_run_steps
        (
            id,
            created_at,
            updated_at,
            automation_run_id,
            automation_action_revision_id,
            ready_at,
            step_attempts,
            started_at,
            finished_at,
            status,
            locked_by,
            locked_at
        ) VALUES (
            :id,
            :created_at,
            :updated_at,
            :automation_run_id,
            :automation_action_revision_id,
            :ready_at,
            0,
            NULL,
            NULL,
            'pending',
            NULL,
            NULL
        )
    `).run({
        id: ObjectId().toHexString(),
        created_at: nowString,
        updated_at: nowString,
        automation_run_id: run.id,
        automation_action_revision_id: firstAction.automation_action_revision_id,
        ready_at: readyAt.toISOString()
    });

}

function findFirstActionRevision(database: DatabaseSync, slug: string): NextActionRevisionRow | null {
    const row = database.prepare(`
        SELECT
            automation.id AS automation_id,
            action.id AS action_id,
            revision.id AS automation_action_revision_id,
            action.type AS type,
            revision.wait_hours AS wait_hours
        FROM automations automation
        INNER JOIN automation_actions action ON action.automation_id = automation.id
        INNER JOIN automation_action_revisions revision ON revision.action_id = action.id
        WHERE automation.slug = ?
            AND automation.status = 'active'
            AND action.deleted_at IS NULL
            AND NOT EXISTS (
                SELECT 1
                FROM automation_action_edges edge
                INNER JOIN automation_actions source_action ON source_action.id = edge.source_action_id
                    AND source_action.deleted_at IS NULL
                WHERE edge.target_action_id = action.id
            )
            AND revision.created_at = (
                SELECT MAX(created_at)
                FROM automation_action_revisions
                WHERE action_id = action.id
            )
        ORDER BY action.created_at, action.id
        LIMIT 1
    `).get(slug) as NextActionRevisionRow | undefined;

    return row ?? null;
}

function findNextPendingReadyAt(database: DatabaseSync, after: string): Date | null {
    const row = database.prepare(`
        SELECT MIN(ready_at) AS next_ready_at
        FROM automation_run_steps
        WHERE status = 'pending'
            AND ready_at > ?
    `).get(after) as {next_ready_at: string | null} | undefined;

    return row?.next_ready_at ? new Date(row.next_ready_at) : null;
}

function finishStepAndEnqueueNext(database: DatabaseSync, step: AutomationStepToRun): Date | null {
    const now = new Date();
    const nowString = now.toISOString();
    const didFinish = updateLockedStep(database, step, {
        status: 'finished',
        started_at: undefined,
        finished_at: nowString,
        ready_at: undefined,
        clearLock: true,
        updated_at: nowString
    });

    if (!didFinish) {
        return null;
    }

    const next = findNextActionRevision(database, step.action_id);

    if (!next) {
        return null;
    }

    const nextReadyAt = getReadyAtForAction(next, now);
    const nextReadyAtString = nextReadyAt.toISOString();

    database.prepare(`
        INSERT INTO automation_run_steps
        (
            id,
            created_at,
            updated_at,
            automation_run_id,
            automation_action_revision_id,
            ready_at,
            step_attempts,
            started_at,
            finished_at,
            status,
            locked_by,
            locked_at
        ) VALUES (
            :id,
            :created_at,
            :updated_at,
            :automation_run_id,
            :automation_action_revision_id,
            :ready_at,
            :step_attempts,
            NULL,
            NULL,
            'pending',
            NULL,
            NULL
        )
    `).run({
        id: ObjectId().toHexString(),
        created_at: nowString,
        updated_at: nowString,
        automation_run_id: step.automation_run_id,
        automation_action_revision_id: next.automation_action_revision_id,
        ready_at: nextReadyAtString,
        step_attempts: 0
    });

    return nextReadyAt;
}

function markStepTerminal(database: DatabaseSync, step: AutomationStepToRun, status: AutomationStepTerminalStatus): boolean {
    const nowString = new Date().toISOString();

    return updateLockedStep(database, step, {
        status,
        started_at: undefined,
        finished_at: nowString,
        ready_at: undefined,
        clearLock: true,
        updated_at: nowString
    });
}

function retryStep(database: DatabaseSync, step: AutomationStepToRun, retryAt: Date): boolean {
    const nowString = new Date().toISOString();

    return updateLockedStep(database, step, {
        status: 'pending',
        started_at: null,
        finished_at: null,
        ready_at: retryAt.toISOString(),
        clearLock: true,
        updated_at: nowString
    });
}

function findNextActionRevision(database: DatabaseSync, sourceActionId: string): NextActionRevisionRow | null {
    const row = database.prepare(`
        SELECT
            action.id AS action_id,
            revision.id AS automation_action_revision_id,
            action.type AS type,
            revision.wait_hours AS wait_hours
        FROM automation_action_edges edge
        INNER JOIN automation_actions action ON action.id = edge.target_action_id
        INNER JOIN automation_action_revisions revision ON revision.action_id = action.id
        WHERE edge.source_action_id = ?
            AND action.deleted_at IS NULL
            AND revision.created_at = (
                SELECT MAX(created_at)
                FROM automation_action_revisions
                WHERE action_id = action.id
            )
        ORDER BY revision.created_at DESC, revision.id DESC
        LIMIT 1
    `).get(sourceActionId) as NextActionRevisionRow | undefined;

    return row ?? null;
}

function getReadyAtForAction(action: Pick<NextActionRevisionRow, 'type' | 'wait_hours'>, now: Date): Date {
    switch (action.type) {
    case 'wait':
        return new Date(now.getTime() + (requireValue({
            id: action.type,
            type: action.type,
            wait_hours: action.wait_hours,
            email_subject: null,
            email_lexical: null,
            email_sender_name: null,
            email_sender_email: null,
            email_sender_reply_to: null,
            email_design_setting_id: null
        }, 'wait_hours') * HOUR_MS));
    case 'send_email':
        return now;
    default: {
        const _exhaustive: never = action.type;
        throw new errors.IncorrectUsageError({
            message: `Unexpected action type ${_exhaustive}`
        });
    }
    }
}

function updateLockedStep(database: DatabaseSync, step: AutomationStepToRun, attrs: {
    status: string;
    started_at?: string | null;
    finished_at?: string | null;
    ready_at?: string;
    clearLock: boolean;
    updated_at: string;
}): boolean {
    const result = database.prepare(`
        UPDATE automation_run_steps
        SET status = :status,
            updated_at = :updated_at,
            started_at = CASE WHEN :set_started_at THEN :started_at ELSE started_at END,
            finished_at = CASE WHEN :set_finished_at THEN :finished_at ELSE finished_at END,
            ready_at = CASE WHEN :set_ready_at THEN :ready_at ELSE ready_at END,
            locked_by = CASE WHEN :clear_lock THEN NULL ELSE locked_by END,
            locked_at = CASE WHEN :clear_lock THEN NULL ELSE locked_at END
        WHERE id = :id
            AND status = 'pending'
            AND locked_by = :locked_by
    `).run({
        id: step.id,
        locked_by: step.locked_by,
        status: attrs.status,
        updated_at: attrs.updated_at,
        set_started_at: attrs.started_at === undefined ? 0 : 1,
        started_at: attrs.started_at ?? null,
        set_finished_at: attrs.finished_at === undefined ? 0 : 1,
        finished_at: attrs.finished_at ?? null,
        set_ready_at: attrs.ready_at === undefined ? 0 : 1,
        ready_at: attrs.ready_at ?? null,
        clear_lock: attrs.clearLock ? 1 : 0
    }) as unknown as {changes: number};

    return result.changes === 1;
}

function buildStepToRun(row: StepRow): AutomationStepToRun {
    const base = {
        id: row.id,
        locked_by: row.locked_by,
        automation_run_id: row.automation_run_id,
        automation_id: row.automation_id,
        automation_slug: row.automation_slug,
        automation_status: row.automation_status,
        member_id: row.member_id,
        member_email: row.member_email,
        action_id: row.action_id,
        automation_action_revision_id: row.automation_action_revision_id,
        ready_at: new Date(row.ready_at),
        step_attempts: row.step_attempts
    };

    switch (row.type) {
    case 'wait':
        return {
            ...base,
            type: 'wait',
            wait_hours: requireValue(row, 'wait_hours')
        };
    case 'send_email':
        return {
            ...base,
            type: 'send_email',
            email_subject: requireValue(row, 'email_subject'),
            email_lexical: requireValue(row, 'email_lexical'),
            email_sender_name: row.email_sender_name,
            email_sender_email: row.email_sender_email,
            email_sender_reply_to: row.email_sender_reply_to,
            email_design_setting_id: row.email_design_setting_id
        };
    }
}

function loadAutomation(database: DatabaseSync, automationId: string): AutomationRow | null {
    const automation = database.prepare(`
        SELECT id, slug, name, status, created_at, updated_at
        FROM automations
        WHERE id = ?
    `).get(automationId) as AutomationRow | undefined;

    return automation ?? null;
}

function loadAutomations(database: DatabaseSync): AutomationRow[] {
    return database.prepare(`
        SELECT id, slug, name, status, created_at, updated_at
        FROM automations
        ORDER BY created_at, id
    `).all() as unknown as AutomationRow[];
}

function updateAutomation(database: DatabaseSync, automation: AutomationRow): AutomationRow {
    database.prepare(`
        UPDATE automations
        SET status = :status,
            updated_at = :updated_at
        WHERE id = :id
    `).run({
        id: automation.id,
        status: automation.status,
        updated_at: automation.updated_at
    });

    return requireAutomation(loadAutomation(database, automation.id), automation.id);
}

function replaceAutomationGraph(database: DatabaseSync, automationId: string, actions: AutomationAction[], edges: AutomationEdge[]) {
    const existingActions = loadAutomationActionRows(database, automationId);
    const existingActionIds = new Set(existingActions.map(action => action.id));
    const submittedActionIds = new Set(actions.map(action => action.id));
    const now = new Date().toISOString();

    for (const action of actions) {
        if (existingActionIds.has(action.id)) {
            const existingAction = existingActions.find(({id}) => id === action.id);

            if (existingAction?.type !== action.type) {
                throw new errors.ValidationError({
                    message: tpl(messages.conflictingAutomationActionType, {
                        actionId: action.id
                    }),
                    property: 'actions.type'
                });
            }
        } else {
            if (loadActionOwner(database, action.id)) {
                throw new errors.ValidationError({
                    message: tpl(messages.conflictingAutomationActionId, {
                        actionId: action.id
                    }),
                    property: 'actions.id'
                });
            }

            insertAction(database, {
                id: action.id,
                created_at: now,
                updated_at: now,
                automation_id: automationId,
                type: action.type
            });
        }

        // TODO (NY-1283): Deduplicate revisions before inserting them.
        insertActionRevision(database, action.id, action, now);
    }

    for (const existingAction of existingActions) {
        if (!submittedActionIds.has(existingAction.id)) {
            softDeleteAction(database, existingAction.id, now);
        }
    }

    deleteAutomationEdges(database, automationId);

    for (const edge of edges) {
        insertActionEdge(database, edge);
    }
}

function loadAutomationActionRows(database: DatabaseSync, automationId: string): Array<Pick<ActionRow, 'id' | 'type'>> {
    return database.prepare(`
        SELECT id, type
        FROM automation_actions
        WHERE automation_id = ?
            AND deleted_at IS NULL
    `).all(automationId) as unknown as Array<Pick<ActionRow, 'id' | 'type'>>;
}

function loadActionOwner(database: DatabaseSync, actionId: string): string | null {
    const row = database.prepare(`
        SELECT automation_id
        FROM automation_actions
        WHERE id = ?
    `).get(actionId) as {automation_id: string} | undefined;

    return row?.automation_id ?? null;
}

function insertAction(database: DatabaseSync, action: {
    id: string;
    created_at: string;
    updated_at: string;
    automation_id: string;
    type: string;
}) {
    database.prepare(`
        INSERT INTO automation_actions
        (id, created_at, updated_at, automation_id, type) VALUES
        (:id, :created_at, :updated_at, :automation_id, :type)
    `).run(action);
}

function softDeleteAction(database: DatabaseSync, actionId: string, deletedAt: string) {
    database.prepare(`
        UPDATE automation_actions
        SET deleted_at = :deleted_at,
            updated_at = :updated_at
        WHERE id = :id
    `).run({
        id: actionId,
        deleted_at: deletedAt,
        updated_at: deletedAt
    });
}

function insertActionRevision(database: DatabaseSync, actionId: string, action: AutomationAction, createdAt: string) {
    const revision = buildActionRevision(actionId, action, getNextRevisionCreatedAt(database, actionId, createdAt));

    database.prepare(`
        INSERT INTO automation_action_revisions
        (
            id,
            created_at,
            action_id,
            wait_hours,
            email_subject,
            email_lexical,
            email_sender_name,
            email_sender_email,
            email_sender_reply_to,
            email_design_setting_id
        ) VALUES (
            :id,
            :created_at,
            :action_id,
            :wait_hours,
            :email_subject,
            :email_lexical,
            :email_sender_name,
            :email_sender_email,
            :email_sender_reply_to,
            :email_design_setting_id
        )
    `).run(revision);
}

function getNextRevisionCreatedAt(database: DatabaseSync, actionId: string, requestedCreatedAt: string) {
    const row = database.prepare(`
        SELECT MAX(created_at) AS created_at
        FROM automation_action_revisions
        WHERE action_id = ?
    `).get(actionId) as {created_at: string | null} | undefined;

    if (!row?.created_at) {
        return requestedCreatedAt;
    }

    const requestedTime = new Date(requestedCreatedAt).getTime();
    const latestTime = new Date(row.created_at).getTime();

    if (requestedTime > latestTime) {
        return requestedCreatedAt;
    }

    return new Date(latestTime + 1).toISOString();
}

function buildActionRevision(actionId: string, action: AutomationAction, createdAt: string) {
    if (action.type === 'wait') {
        return {
            id: ObjectId().toString(),
            created_at: createdAt,
            action_id: actionId,
            wait_hours: action.data.wait_hours,
            email_subject: null,
            email_lexical: null,
            email_sender_name: null,
            email_sender_email: null,
            email_sender_reply_to: null,
            email_design_setting_id: null
        };
    }

    return {
        id: ObjectId().toString(),
        created_at: createdAt,
        action_id: actionId,
        wait_hours: null,
        email_subject: action.data.email_subject,
        email_lexical: action.data.email_lexical,
        email_sender_name: action.data.email_sender_name,
        email_sender_email: action.data.email_sender_email,
        email_sender_reply_to: action.data.email_sender_reply_to,
        email_design_setting_id: action.data.email_design_setting_id
    };
}

function deleteAutomationEdges(database: DatabaseSync, automationId: string) {
    database.prepare(`
        DELETE FROM automation_action_edges
        WHERE source_action_id IN (
            SELECT id
            FROM automation_actions
            WHERE automation_id = ?
        )
    `).run(automationId);
}

function insertActionEdge(database: DatabaseSync, edge: AutomationEdge) {
    database.prepare(`
        INSERT INTO automation_action_edges
        (source_action_id, target_action_id) VALUES
        (:source_action_id, :target_action_id)
    `).run({
        source_action_id: edge.source_action_id,
        target_action_id: edge.target_action_id
    });
}

function requireAutomation(automation: AutomationRow | null, id: string): AutomationRow {
    if (!automation) {
        throw new errors.InternalServerError({
            message: `Updated automation "${id}" could not be loaded.`
        });
    }

    return automation;
}

function buildAutomation(database: DatabaseSync, automation: AutomationRow): Automation {
    return {
        ...buildAutomationSummary(automation),
        actions: loadActionRows(database, automation.id).map(row => buildActionPayload(row)),
        edges: loadEdgeRows(database, automation.id).map(row => buildEdgePayload(row))
    };
}

function buildAutomationSummary(automation: AutomationRow): AutomationSummary {
    return {
        id: automation.id,
        slug: automation.slug,
        name: automation.name,
        status: automation.status,
        created_at: serializeDate(automation.created_at),
        updated_at: serializeDate(automation.updated_at)
    };
}

function serializeDate(date: string) {
    const normalizedDate = new Date(date);
    normalizedDate.setMilliseconds(0);
    return normalizedDate.toISOString();
}

function loadActionRows(database: DatabaseSync, automationId: string): ActionRow[] {
    return database.prepare(`
        SELECT
            a.id AS id,
            a.type AS type,
            r.wait_hours AS wait_hours,
            r.email_subject AS email_subject,
            r.email_lexical AS email_lexical,
            r.email_sender_name AS email_sender_name,
            r.email_sender_email AS email_sender_email,
            r.email_sender_reply_to AS email_sender_reply_to,
            r.email_design_setting_id AS email_design_setting_id
        FROM automation_actions a
        INNER JOIN automation_action_revisions r ON r.action_id = a.id
        WHERE a.automation_id = ?
            AND a.deleted_at IS NULL
            AND r.created_at = (
                SELECT MAX(created_at)
                FROM automation_action_revisions
                WHERE action_id = a.id
            )
        ORDER BY a.created_at, a.id
    `).all(automationId) as unknown as ActionRow[];
}

function loadEdgeRows(database: DatabaseSync, automationId: string): EdgeRow[] {
    return database.prepare(`
        SELECT e.source_action_id, e.target_action_id
        FROM automation_action_edges e
        INNER JOIN automation_actions source_action ON source_action.id = e.source_action_id
            AND source_action.deleted_at IS NULL
        INNER JOIN automation_actions target_action ON target_action.id = e.target_action_id
            AND target_action.deleted_at IS NULL
            AND target_action.automation_id = source_action.automation_id
        WHERE source_action.automation_id = ?
        ORDER BY e.source_action_id, e.target_action_id
    `).all(automationId) as unknown as EdgeRow[];
}

function buildActionPayload(row: ActionRow): AutomationAction {
    switch (row.type) {
    case 'wait':
        return {
            id: row.id,
            type: 'wait',
            data: {
                wait_hours: requireValue(row, 'wait_hours')
            }
        };
    case 'send_email':
        return {
            id: row.id,
            type: 'send_email',
            data: {
                email_subject: requireValue(row, 'email_subject'),
                email_lexical: requireValue(row, 'email_lexical'),
                email_sender_name: row.email_sender_name,
                email_sender_email: row.email_sender_email,
                email_sender_reply_to: row.email_sender_reply_to,
                email_design_setting_id: requireValue(row, 'email_design_setting_id')
            }
        };
    }
}

function requireValue<FieldT extends keyof ActionRow>(
    row: Pick<ActionRow, 'id' | 'type' | FieldT>,
    field: FieldT
): NonNullable<ActionRow[FieldT]> {
    const value = row[field];
    if (value === null) {
        throw new errors.InternalServerError({
            message: tpl(messages.invalidAutomationActionRevision, {
                actionId: row.id,
                actionType: row.type,
                field
            })
        });
    }
    return value;
}

function buildEdgePayload(edge: EdgeRow): AutomationEdge {
    return {
        source_action_id: edge.source_action_id,
        target_action_id: edge.target_action_id
    };
}

function buildPagination(total: number) {
    return {
        page: 1,
        pages: 1,
        limit: 'all' as const,
        total,
        prev: null,
        next: null
    };
}
