/* eslint-disable @typescript-eslint/no-require-imports */
import type {AutomationStepToRun, AutomationsRepository} from './automations-repository';

const MAX_STEPS_PER_BATCH = 100;
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 10 * 60 * 1000;

const logging = require('@tryghost/logging');
const {Member} = require('../../models');
const {MEMBER_WELCOME_EMAIL_ELIGIBLE_STATUSES, MEMBER_WELCOME_EMAIL_SLUGS} = require('../member-welcome-emails/constants');

type MemberWelcomeEmailService = {
    init: () => unknown;
    api: {
        sendAutomationEmail: (options: {
            email: {
                designSettingId: string | null;
                lexical: string;
                senderEmail: string | null;
                senderName: string | null;
                senderReplyTo: string | null;
                subject: string;
            };
            member: {
                email: string;
                name: string | null;
                uuid: string;
            };
            memberStatus: 'free' | 'paid';
        }) => Promise<unknown>;
    };
};

type MemberModel = {
    get: (key: 'email' | 'name' | 'status' | 'uuid') => string | null;
};

type PollOptions = {
    automationsRepository: AutomationsRepository;
    enqueueAnotherPollAt: (date: Readonly<Date>) => unknown;
    memberWelcomeEmailService: MemberWelcomeEmailService;
};

const slugToMemberStatus = new Map<string, 'free' | 'paid'>(
    Object.entries(MEMBER_WELCOME_EMAIL_SLUGS).map(([status, slug]) => [slug as string, status as 'free' | 'paid'])
);

const markMaxAttemptsExceeded = async (automationsRepository: AutomationsRepository, step: AutomationStepToRun): Promise<void> => {
    await automationsRepository.markStepTerminal(step, 'email send failed');
    logging.warn({
        system: {
            event: 'automations.neopoll.max_attempts',
            step_id: step.id
        }
    }, `[AUTOMATIONS] Step ${step.id} exceeded max attempts`);
};

const processStep = async ({
    automationsRepository,
    enqueueAnotherPollAt,
    memberWelcomeEmailService,
    step
}: Readonly<PollOptions & {
    step: AutomationStepToRun;
}>): Promise<void> => {
    if (step.step_attempts > MAX_ATTEMPTS) {
        await markMaxAttemptsExceeded(automationsRepository, step);
        return;
    }

    if (step.automation_status !== 'active') {
        await automationsRepository.markStepTerminal(step, 'automation disabled');
        return;
    }

    const memberStatus = slugToMemberStatus.get(step.automation_slug);
    if (!memberStatus) {
        logging.error({
            system: {
                event: 'automations.neopoll.unknown_slug',
                slug: step.automation_slug,
                step_id: step.id
            }
        }, `[AUTOMATIONS] Unknown automation slug: ${step.automation_slug}`);

        await automationsRepository.markStepTerminal(step, 'email send failed');
        return;
    }

    if (!step.member_id) {
        await automationsRepository.markStepTerminal(step, 'member unsubscribed');
        return;
    }

    const member = await Member.findOne({id: step.member_id}) as MemberModel | null;

    if (!member) {
        await automationsRepository.markStepTerminal(step, 'member unsubscribed');
        return;
    }

    const eligibleStatuses = MEMBER_WELCOME_EMAIL_ELIGIBLE_STATUSES[memberStatus] as readonly string[];
    if (!eligibleStatuses.includes(member.get('status') ?? '')) {
        await automationsRepository.markStepTerminal(step, 'member changed status');
        return;
    }

    switch (step.type) {
    case 'wait': {
        const nextReadyAt = await automationsRepository.finishStepAndEnqueueNext(step);

        if (nextReadyAt) {
            enqueueAnotherPollAt(nextReadyAt);
        }

        return;
    }
    case 'send_email': {
        try {
            await memberWelcomeEmailService.api.sendAutomationEmail({
                email: {
                    designSettingId: step.email_design_setting_id,
                    lexical: step.email_lexical,
                    senderEmail: step.email_sender_email,
                    senderName: step.email_sender_name,
                    senderReplyTo: step.email_sender_reply_to,
                    subject: step.email_subject
                },
                member: {
                    email: member.get('email') ?? step.member_email,
                    name: member.get('name'),
                    uuid: member.get('uuid') ?? ''
                },
                memberStatus
            });

            const nextReadyAt = await automationsRepository.finishStepAndEnqueueNext(step);

            if (nextReadyAt) {
                enqueueAnotherPollAt(nextReadyAt);
            }
        } catch (err) {
            logging.error({
                err,
                system: {
                    event: 'automations.neopoll.send_failed',
                    step_id: step.id
                }
            }, `[AUTOMATIONS] Failed to send automation email for step ${step.id}`);

            if (step.step_attempts < MAX_ATTEMPTS) {
                const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
                const didRetry = await automationsRepository.retryStep(step, retryAt);

                if (didRetry) {
                    enqueueAnotherPollAt(retryAt);
                }
            } else {
                await markMaxAttemptsExceeded(automationsRepository, step);
            }
        }

        return;
    }
    }
};

/**
 * Run automations that need it.
 *
 * Runs up to 100 in a batch. If that's met or exceeded, a request to poll
 * again is dispatched.
 */
export const poll = async ({
    automationsRepository,
    enqueueAnotherPollAt,
    memberWelcomeEmailService
}: Readonly<PollOptions>): Promise<void> => {
    const {steps, nextStepReadyAt} = await automationsRepository.fetchAndLockSteps(MAX_STEPS_PER_BATCH);

    if (steps.length === 0) {
        if (nextStepReadyAt) {
            enqueueAnotherPollAt(nextStepReadyAt);
        }
        return;
    }

    const hasEmailSteps = steps.some(step => step.type === 'send_email');
    if (hasEmailSteps) {
        memberWelcomeEmailService.init();
    }

    const results = await Promise.allSettled(steps.map(async (step) => {
        await processStep({
            automationsRepository,
            enqueueAnotherPollAt,
            memberWelcomeEmailService,
            step
        });
    }));

    for (const result of results) {
        if (result.status === 'rejected') {
            logging.error({
                err: result.reason,
                system: {
                    event: 'automations.neopoll.step_failed'
                }
            }, '[AUTOMATIONS] Failed to process automation step');
        }
    }

    // If the batch is full, we might have another batch to execute. (There's
    // no way to know without trying.)
    if (steps.length >= MAX_STEPS_PER_BATCH) {
        enqueueAnotherPollAt(new Date());
    }
};
