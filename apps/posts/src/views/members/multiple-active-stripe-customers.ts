import {z} from 'zod';
import type {User} from '@tryghost/admin-x-framework/api/users';

export const MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER = 'count.active_stripe_customers:>1';

const MultipleActiveStripeCustomersBannerPreferenceSchema = z.looseObject({
    dismissedCount: z.number().finite().optional().catch(undefined),
    dismissedAt: z.string().optional().catch(undefined)
});

const AccessibilityPreferencesSchema = z.looseObject({
    multipleActiveStripeCustomersBanner: MultipleActiveStripeCustomersBannerPreferenceSchema.optional().catch(undefined)
});

export type AccessibilityPreferences = z.infer<typeof AccessibilityPreferencesSchema>;
export type MultipleActiveStripeCustomersBannerPreference = z.infer<typeof MultipleActiveStripeCustomersBannerPreferenceSchema>;

export function isMultipleActiveStripeCustomersFilter(nql: string | undefined): boolean {
    return nql === MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER;
}

export function parseAccessibilityPreferences(accessibility: string | null | undefined): AccessibilityPreferences {
    if (!accessibility) {
        return AccessibilityPreferencesSchema.parse({});
    }

    try {
        const parsed = JSON.parse(accessibility);
        return AccessibilityPreferencesSchema.parse(parsed);
    } catch {
        return AccessibilityPreferencesSchema.parse({});
    }
}

export function getMultipleActiveStripeCustomersBannerPreference(
    accessibility: string | null | undefined
): MultipleActiveStripeCustomersBannerPreference {
    const preferences = parseAccessibilityPreferences(accessibility);
    return preferences.multipleActiveStripeCustomersBanner ?? {};
}

export function buildDismissedMultipleActiveStripeCustomersPreference(
    accessibility: string | null | undefined,
    dismissedCount: number,
    dismissedAt: string
): string {
    const preferences = parseAccessibilityPreferences(accessibility);
    const currentBannerPreference = getMultipleActiveStripeCustomersBannerPreference(accessibility);

    return JSON.stringify({
        ...preferences,
        multipleActiveStripeCustomersBanner: {
            ...currentBannerPreference,
            dismissedCount,
            dismissedAt
        }
    });
}

export function buildUserWithDismissedMultipleActiveStripeCustomersBanner(
    user: User,
    dismissedCount: number,
    dismissedAt: string
): User {
    return {
        ...user,
        accessibility: buildDismissedMultipleActiveStripeCustomersPreference(
            user.accessibility,
            dismissedCount,
            dismissedAt
        )
    };
}
