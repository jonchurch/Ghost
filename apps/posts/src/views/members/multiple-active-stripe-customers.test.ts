import {
    MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER,
    buildDismissedMultipleActiveStripeCustomersPreference,
    getMultipleActiveStripeCustomersBannerPreference,
    isMultipleActiveStripeCustomersFilter,
    parseAccessibilityPreferences
} from './multiple-active-stripe-customers';
import {describe, expect, it} from 'vitest';

describe('multiple active Stripe customers helpers', () => {
    it('matches only the exact raw filter used by the banner', () => {
        expect(isMultipleActiveStripeCustomersFilter(MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER)).toBe(true);
        expect(isMultipleActiveStripeCustomersFilter(`${MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER}+status:paid`)).toBe(false);
        expect(isMultipleActiveStripeCustomersFilter(undefined)).toBe(false);
    });

    it('parses invalid accessibility JSON as empty preferences', () => {
        expect(parseAccessibilityPreferences('{invalid json')).toEqual({});
        expect(getMultipleActiveStripeCustomersBannerPreference('{invalid json')).toEqual({});
    });

    it('ignores invalid dismissal preference values', () => {
        const accessibility = JSON.stringify({
            multipleActiveStripeCustomersBanner: {
                dismissedCount: 'abc',
                dismissedAt: 123,
                customFutureKey: 'preserved'
            }
        });

        expect(getMultipleActiveStripeCustomersBannerPreference(accessibility)).toEqual({
            dismissedCount: undefined,
            dismissedAt: undefined,
            customFutureKey: 'preserved'
        });
    });

    it('preserves unknown accessibility keys when writing dismissal state', () => {
        const accessibility = JSON.stringify({
            nightShift: true,
            onboarding: {
                checklistState: 'started'
            },
            multipleActiveStripeCustomersBanner: {
                dismissedCount: 1,
                customFutureKey: 'preserved'
            }
        });

        expect(JSON.parse(buildDismissedMultipleActiveStripeCustomersPreference(
            accessibility,
            3,
            '2026-05-28T12:34:56.000Z'
        ))).toEqual({
            nightShift: true,
            onboarding: {
                checklistState: 'started'
            },
            multipleActiveStripeCustomersBanner: {
                dismissedCount: 3,
                dismissedAt: '2026-05-28T12:34:56.000Z',
                customFutureKey: 'preserved'
            }
        });
    });
});
