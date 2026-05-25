const assert = require('node:assert/strict');
const ObjectId = require('bson-objectid').default;
const sinon = require('sinon');

const {createFakeDatabaseAutomationsRepository} = require('../../../../../core/server/services/automations/fake-database-automations-repository');
const temporaryFakeAutomationsDatabase = require('../../../../../core/server/services/automations/temporary-fake-database');

describe('fake database automations repository', function () {
    let database;
    let repository;

    beforeEach(function () {
        sinon.useFakeTimers({now: new Date('2026-04-12T12:00:00.000Z'), shouldAdvanceTime: true});

        database = temporaryFakeAutomationsDatabase.createTemporaryFakeAutomationsDatabase();
        repository = createFakeDatabaseAutomationsRepository({
            getDatabase: () => database
        });
    });

    afterEach(function () {
        sinon.restore();
        database.close();
    });

    function getAutomation(slug = 'member-welcome-email-free') {
        return database.prepare(`
            SELECT *
            FROM automations
            WHERE slug = ?
        `).get(slug);
    }

    function getActionByIndex(automationId, index) {
        return database.prepare(`
            SELECT
                action.id AS action_id,
                action.type AS type,
                revision.id AS revision_id,
                revision.wait_hours AS wait_hours
            FROM automation_actions action
            INNER JOIN automation_action_revisions revision ON revision.action_id = action.id
            WHERE action.automation_id = ?
                AND action.deleted_at IS NULL
            ORDER BY action.created_at, action.id
            LIMIT 1 OFFSET ?
        `).get(automationId, index);
    }

    function insertRun(automationId, attrs = {}) {
        const now = new Date().toISOString();
        const run = {
            id: ObjectId().toHexString(),
            created_at: now,
            updated_at: now,
            automation_id: automationId,
            member_id: ObjectId().toHexString(),
            member_email: 'member@example.com',
            ...attrs
        };

        database.prepare(`
            INSERT INTO automation_runs
            (id, created_at, updated_at, automation_id, member_id, member_email) VALUES
            (:id, :created_at, :updated_at, :automation_id, :member_id, :member_email)
        `).run(run);

        return run;
    }

    function insertStep(runId, revisionId, attrs = {}) {
        const now = new Date().toISOString();
        const step = {
            id: ObjectId().toHexString(),
            created_at: now,
            updated_at: now,
            automation_run_id: runId,
            automation_action_revision_id: revisionId,
            ready_at: now,
            step_attempts: 0,
            started_at: null,
            finished_at: null,
            status: 'pending',
            locked_by: null,
            locked_at: null,
            ...attrs
        };

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
                :started_at,
                :finished_at,
                :status,
                :locked_by,
                :locked_at
            )
        `).run(step);

        return step;
    }

    function getStep(id) {
        return database.prepare(`
            SELECT *
            FROM automation_run_steps
            WHERE id = ?
        `).get(id);
    }

    function listSteps() {
        return database.prepare(`
            SELECT *
            FROM automation_run_steps
            ORDER BY created_at, id
        `).all();
    }

    function listRuns() {
        return database.prepare(`
            SELECT *
            FROM automation_runs
            ORDER BY created_at, id
        `).all();
    }

    it('enqueues a run and first step for the first action in an active automation', async function () {
        const run = await repository.enqueueRun({
            memberEmail: 'member@example.com',
            memberId: 'member-id',
            slug: 'member-welcome-email-free'
        });

        assert.ok(run.id);

        const runs = listRuns();
        assert.equal(runs.length, 1);
        assert.equal(runs[0].id, run.id);
        assert.equal(runs[0].member_id, 'member-id');
        assert.equal(runs[0].member_email, 'member@example.com');

        const steps = listSteps();
        assert.equal(steps.length, 1);
        assert.equal(steps[0].automation_run_id, run.id);
        assert.equal(steps[0].status, 'pending');
        assert.equal(steps[0].step_attempts, 0);
        assert.equal(new Date(steps[0].ready_at).getTime(), Date.now() + (48 * 60 * 60 * 1000));
    });

    it('does not enqueue a run when the automation is inactive', async function () {
        const automation = getAutomation();
        database.prepare(`
            UPDATE automations
            SET status = 'inactive'
            WHERE id = ?
        `).run(automation.id);

        const run = await repository.enqueueRun({
            memberEmail: 'member@example.com',
            memberId: 'member-id',
            slug: 'member-welcome-email-free'
        });

        assert.equal(run, null);
        assert.deepEqual(listRuns(), []);
        assert.deepEqual(listSteps(), []);
    });

    it('locks ready pending and stale running steps, but skips future and fresh running steps', async function () {
        const automation = getAutomation();
        const action = getActionByIndex(automation.id, 0);
        const run = insertRun(automation.id);
        const ready = insertStep(run.id, action.revision_id, {
            ready_at: new Date(Date.now() - 1000).toISOString()
        });
        const stale = insertStep(run.id, action.revision_id, {
            locked_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            ready_at: new Date(Date.now() - 1000).toISOString(),
            status: 'running',
            locked_by: 'old-lock',
            step_attempts: 2
        });
        insertStep(run.id, action.revision_id, {
            ready_at: new Date(Date.now() + 60 * 1000).toISOString()
        });
        insertStep(run.id, action.revision_id, {
            locked_at: new Date(Date.now() - (29 * 60 * 1000)).toISOString(),
            ready_at: new Date(Date.now() - 1000).toISOString(),
            status: 'running',
            locked_by: 'fresh-lock'
        });

        const result = await repository.fetchAndLockSteps(10);

        assert.deepEqual(result.steps.map(step => step.id).sort(), [ready.id, stale.id].sort());
        assert.equal(result.nextStepReadyAt, null);

        const lockedReady = getStep(ready.id);
        assert.equal(lockedReady.status, 'running');
        assert.equal(lockedReady.step_attempts, 1);
        assert.equal(typeof lockedReady.locked_by, 'string');
        assert.equal(lockedReady.locked_by, result.steps[0].locked_by);

        const lockedStale = getStep(stale.id);
        assert.equal(lockedStale.status, 'running');
        assert.equal(lockedStale.step_attempts, 3);
        assert.equal(lockedStale.locked_by, result.steps[0].locked_by);
    });

    it('returns the next future pending ready_at when no steps can be locked', async function () {
        const automation = getAutomation();
        const action = getActionByIndex(automation.id, 0);
        const run = insertRun(automation.id);
        const later = new Date(Date.now() + 60 * 1000);
        const sooner = new Date(Date.now() + 30 * 1000);

        insertStep(run.id, action.revision_id, {ready_at: later.toISOString()});
        insertStep(run.id, action.revision_id, {ready_at: sooner.toISOString()});

        const result = await repository.fetchAndLockSteps(10);

        assert.deepEqual(result.steps, []);
        assert.equal(result.nextStepReadyAt.getTime(), sooner.getTime());
    });

    it('finishes a locked step and enqueues the next action revision', async function () {
        const automation = getAutomation();
        const action = getActionByIndex(automation.id, 0);
        const run = insertRun(automation.id);
        const stepRow = insertStep(run.id, action.revision_id, {
            ready_at: new Date(Date.now() - 1000).toISOString()
        });
        const {steps} = await repository.fetchAndLockSteps(10);
        const step = steps.find(candidate => candidate.id === stepRow.id);

        const nextReadyAt = await repository.finishStepAndEnqueueNext(step);

        assert.equal(nextReadyAt.getTime(), Date.now());

        const finished = getStep(stepRow.id);
        assert.equal(finished.status, 'finished');
        assert.equal(finished.locked_by, null);
        assert.equal(typeof finished.finished_at, 'string');

        const allSteps = listSteps();
        assert.equal(allSteps.length, 2);
        const nextStep = allSteps.find(candidate => candidate.id !== stepRow.id);
        const nextAction = getActionByIndex(automation.id, 1);
        assert.equal(nextStep.automation_run_id, run.id);
        assert.equal(nextStep.automation_action_revision_id, nextAction.revision_id);
        assert.equal(nextStep.status, 'pending');
        assert.equal(new Date(nextStep.ready_at).getTime(), nextReadyAt.getTime());
    });

    it('uses wait hours when the next action is a wait action', async function () {
        const automation = getAutomation();
        const sendEmailAction = getActionByIndex(automation.id, 1);
        const run = insertRun(automation.id);
        const stepRow = insertStep(run.id, sendEmailAction.revision_id, {
            ready_at: new Date(Date.now() - 1000).toISOString()
        });
        const {steps} = await repository.fetchAndLockSteps(10);
        const step = steps.find(candidate => candidate.id === stepRow.id);

        const nextReadyAt = await repository.finishStepAndEnqueueNext(step);

        assert.equal(nextReadyAt.getTime(), Date.now() + (72 * 60 * 60 * 1000));
    });

    it('does not update terminal or retry state after the lock is lost', async function () {
        const automation = getAutomation();
        const action = getActionByIndex(automation.id, 0);
        const run = insertRun(automation.id);
        const stepRow = insertStep(run.id, action.revision_id, {
            ready_at: new Date(Date.now() - 1000).toISOString()
        });
        const {steps} = await repository.fetchAndLockSteps(10);
        const step = steps.find(candidate => candidate.id === stepRow.id);

        database.prepare(`
            UPDATE automation_run_steps
            SET locked_by = 'other-lock'
            WHERE id = ?
        `).run(step.id);

        assert.equal(await repository.markStepTerminal(step, 'automation disabled'), false);
        assert.equal(await repository.retryStep(step, new Date(Date.now() + 1000)), false);

        const unchanged = getStep(step.id);
        assert.equal(unchanged.status, 'running');
        assert.equal(unchanged.locked_by, 'other-lock');
    });
});
