const assert = require('node:assert/strict');
const sinon = require('sinon');

const {poll} = require('../../../../../core/server/services/automations/neopoll');
const {Member} = require('../../../../../core/server/models');
const {MEMBER_WELCOME_EMAIL_SLUGS} = require('../../../../../core/server/services/member-welcome-emails/constants');

const MAX_STEPS_PER_BATCH = 100;
const RETRY_DELAY_MS = 10 * 60 * 1000;

describe('automations neopoll', function () {
    let automationsRepository;
    let memberWelcomeEmailService;
    let options;

    beforeEach(function () {
        sinon.useFakeTimers({now: new Date('2026-04-12T12:00:00.000Z'), shouldAdvanceTime: true});

        automationsRepository = {
            fetchAndLockSteps: sinon.stub().resolves({steps: [], nextStepReadyAt: null}),
            finishStepAndEnqueueNext: sinon.stub().resolves(null),
            markStepTerminal: sinon.stub().resolves(true),
            retryStep: sinon.stub().resolves(true)
        };

        memberWelcomeEmailService = {
            init: sinon.stub(),
            api: {
                loadMemberWelcomeEmails: sinon.stub().resolves(),
                sendAutomationEmail: sinon.stub().resolves()
            }
        };

        options = {
            automationsRepository,
            enqueueAnotherPollAt: sinon.stub(),
            memberWelcomeEmailService
        };

        sinon.stub(Member, 'findOne').resolves(buildMember());
    });

    afterEach(function () {
        sinon.restore();
    });

    function buildMember(attrs = {}) {
        const values = {
            email: 'member@example.com',
            name: 'Test Member',
            status: 'free',
            uuid: '00000000-0000-4000-8000-000000000001',
            ...attrs
        };

        return {
            get(key) {
                return values[key];
            }
        };
    }

    function buildStep(attrs = {}) {
        return {
            id: `step-${Math.random()}`,
            locked_by: 'lock-id',
            automation_run_id: 'run-id',
            automation_id: 'automation-id',
            automation_slug: MEMBER_WELCOME_EMAIL_SLUGS.free,
            automation_status: 'active',
            member_id: 'member-id',
            member_email: 'member@example.com',
            action_id: 'action-id',
            automation_action_revision_id: 'revision-id',
            ready_at: new Date(),
            step_attempts: 1,
            type: 'wait',
            wait_hours: 24,
            ...attrs
        };
    }

    function buildEmailStep(attrs = {}) {
        return buildStep({
            type: 'send_email',
            wait_hours: undefined,
            email_subject: 'Welcome!',
            email_lexical: JSON.stringify({root: {children: [], direction: null, format: '', indent: 0, type: 'root', version: 1}}),
            email_sender_name: null,
            email_sender_email: null,
            email_sender_reply_to: null,
            email_design_setting_id: null,
            ...attrs
        });
    }

    it('does nothing when no steps are ready', async function () {
        await poll(options);

        sinon.assert.calledOnceWithExactly(automationsRepository.fetchAndLockSteps, MAX_STEPS_PER_BATCH);
        sinon.assert.notCalled(options.enqueueAnotherPollAt);
        sinon.assert.notCalled(memberWelcomeEmailService.init);
    });

    it('enqueues the next future poll when no steps are ready', async function () {
        const nextStepReadyAt = new Date(Date.now() + 60 * 1000);
        automationsRepository.fetchAndLockSteps.resolves({steps: [], nextStepReadyAt});

        await poll(options);

        sinon.assert.calledOnceWithExactly(options.enqueueAnotherPollAt, nextStepReadyAt);
        sinon.assert.notCalled(memberWelcomeEmailService.init);
    });

    it('keeps processing other steps if one rejects', async function () {
        const step1 = buildStep({id: 'step-1'});
        const step2 = buildStep({id: 'step-2'});
        automationsRepository.fetchAndLockSteps.resolves({steps: [step1, step2], nextStepReadyAt: null});
        automationsRepository.finishStepAndEnqueueNext.withArgs(step1).rejects(new Error('finish failed'));
        automationsRepository.finishStepAndEnqueueNext.withArgs(step2).resolves(null);

        await poll(options);

        sinon.assert.calledWith(automationsRepository.finishStepAndEnqueueNext, step1);
        sinon.assert.calledWith(automationsRepository.finishStepAndEnqueueNext, step2);
    });

    it('enqueues another immediate poll when the batch is full', async function () {
        const beforePoll = new Date();
        automationsRepository.fetchAndLockSteps.resolves({
            steps: Array.from({length: MAX_STEPS_PER_BATCH}, () => buildStep()),
            nextStepReadyAt: null
        });

        await poll(options);

        sinon.assert.calledWith(options.enqueueAnotherPollAt, sinon.match(date => (
            date instanceof Date &&
            date >= beforePoll &&
            date <= new Date()
        )));
    });

    it('marks the step failed without sending when max attempts are exceeded', async function () {
        const step = buildEmailStep({step_attempts: 11});
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});

        await poll(options);

        sinon.assert.notCalled(memberWelcomeEmailService.api.sendAutomationEmail);
        sinon.assert.calledOnceWithExactly(automationsRepository.markStepTerminal, step, 'email send failed');
    });

    it('bails if the automation is inactive', async function () {
        const step = buildEmailStep({automation_status: 'inactive'});
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});

        await poll(options);

        sinon.assert.notCalled(memberWelcomeEmailService.api.sendAutomationEmail);
        sinon.assert.calledOnceWithExactly(automationsRepository.markStepTerminal, step, 'automation disabled');
    });

    it('bails if the member no longer exists', async function () {
        const step = buildEmailStep();
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        Member.findOne.resolves(null);

        await poll(options);

        sinon.assert.notCalled(memberWelcomeEmailService.api.sendAutomationEmail);
        sinon.assert.calledOnceWithExactly(automationsRepository.markStepTerminal, step, 'member unsubscribed');
    });

    it('bails if the member status changed', async function () {
        const step = buildEmailStep();
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        Member.findOne.resolves(buildMember({status: 'paid'}));

        await poll(options);

        sinon.assert.notCalled(memberWelcomeEmailService.api.sendAutomationEmail);
        sinon.assert.calledOnceWithExactly(automationsRepository.markStepTerminal, step, 'member changed status');
    });

    it('allows paid welcome emails for gift members', async function () {
        const step = buildEmailStep({
            automation_slug: MEMBER_WELCOME_EMAIL_SLUGS.paid
        });
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        Member.findOne.resolves(buildMember({status: 'gift'}));

        await poll(options);

        sinon.assert.calledOnceWithExactly(memberWelcomeEmailService.api.sendAutomationEmail, sinon.match({
            memberStatus: 'paid'
        }));
        sinon.assert.calledOnceWithExactly(automationsRepository.finishStepAndEnqueueNext, step);
    });

    it('sends email revision content and enqueues the next step', async function () {
        const nextReadyAt = new Date(Date.now() + 60 * 1000);
        const step = buildEmailStep({
            email_design_setting_id: 'design-id',
            email_sender_email: 'sender@example.com',
            email_sender_name: 'Sender',
            email_sender_reply_to: 'reply@example.com'
        });
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        automationsRepository.finishStepAndEnqueueNext.resolves(nextReadyAt);

        await poll(options);

        sinon.assert.calledOnce(memberWelcomeEmailService.init);
        sinon.assert.calledOnceWithExactly(memberWelcomeEmailService.api.sendAutomationEmail, sinon.match({
            email: {
                designSettingId: 'design-id',
                lexical: step.email_lexical,
                senderEmail: 'sender@example.com',
                senderName: 'Sender',
                senderReplyTo: 'reply@example.com',
                subject: 'Welcome!'
            },
            memberStatus: 'free'
        }));
        sinon.assert.calledOnceWithExactly(options.enqueueAnotherPollAt, nextReadyAt);
    });

    it('retries email send failures', async function () {
        const step = buildEmailStep({step_attempts: 1});
        const pollStart = Date.now();
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        memberWelcomeEmailService.api.sendAutomationEmail.rejects(new Error('send failed'));

        await poll(options);

        const retryAt = automationsRepository.retryStep.firstCall.args[1];
        assert.ok(Math.abs(retryAt.getTime() - (pollStart + RETRY_DELAY_MS)) < 2000);
        sinon.assert.calledOnceWithExactly(automationsRepository.retryStep, step, retryAt);
        sinon.assert.calledOnceWithExactly(options.enqueueAnotherPollAt, retryAt);
    });

    it('permanently fails email send failures at the attempt limit', async function () {
        const step = buildEmailStep({step_attempts: 10});
        automationsRepository.fetchAndLockSteps.resolves({steps: [step], nextStepReadyAt: null});
        memberWelcomeEmailService.api.sendAutomationEmail.rejects(new Error('send failed'));

        await poll(options);

        sinon.assert.notCalled(automationsRepository.retryStep);
        sinon.assert.calledOnceWithExactly(automationsRepository.markStepTerminal, step, 'email send failed');
    });
});
