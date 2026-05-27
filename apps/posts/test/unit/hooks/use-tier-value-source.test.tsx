import {beforeEach, describe, expect, it, vi} from 'vitest';
import {buildTierFilterOptions, hasMultipleTierOptions} from '@src/hooks/filter-sources/use-tier-value-source';
import {renderHook} from '@testing-library/react';
import {useTierValueSource} from '@src/hooks/filter-sources/use-tier-value-source';
import type {Tier} from '@tryghost/admin-x-framework/api/tiers';

const {mockUseBrowseTiers} = vi.hoisted(() => ({
    mockUseBrowseTiers: vi.fn()
}));

vi.mock('@tryghost/admin-x-framework/api/tiers', () => ({
    useBrowseTiers: mockUseBrowseTiers
}));

function tier(overrides: Partial<Tier>): Tier {
    return {
        id: 'tier-id',
        name: 'Tier',
        description: null,
        slug: 'tier',
        active: true,
        type: 'paid',
        welcome_page_url: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        visibility: 'public',
        benefits: [],
        trial_days: 0,
        ...overrides
    };
}

describe('useTierValueSource', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('builds grouped active and archived tier options in display order', () => {
        const tiers = [
            tier({id: 'archived', name: 'Archived Gold', slug: 'archived-gold', active: false}),
            tier({id: 'active', name: 'Active Gold', slug: 'active-gold', active: true})
        ];

        expect(buildTierFilterOptions(tiers)).toEqual([
            {
                value: 'active',
                label: 'Active Gold',
                detail: 'active-gold',
                group: 'Active tiers'
            },
            {
                value: 'archived',
                label: 'Archived Gold',
                detail: 'archived-gold',
                group: 'Archived tiers'
            }
        ]);
    });

    it('counts fetched paid tiers when deciding if the tier filter is available', () => {
        expect(hasMultipleTierOptions([
            tier({id: 'active', active: true}),
            tier({id: 'archived', active: false})
        ])).toBe(true);

        expect(hasMultipleTierOptions([
            tier({id: 'archived-1', active: false}),
            tier({id: 'archived-2', active: false})
        ])).toBe(true);

        expect(hasMultipleTierOptions([
            tier({id: 'archived', active: false})
        ])).toBe(false);

        expect(hasMultipleTierOptions([])).toBe(false);
    });

    it('fetches paid tiers with a numeric page limit and exposes grouped tier options', () => {
        mockUseBrowseTiers.mockReturnValue({
            data: {
                tiers: [
                    tier({id: 'active-tier', name: 'Active Gold', slug: 'active-gold', active: true}),
                    tier({id: 'archived-tier', name: 'Archived Gold', slug: 'archived-gold', active: false})
                ],
                isEnd: true
            },
            fetchNextPage: vi.fn(),
            isFetchingNextPage: false,
            isLoading: false
        });

        const {result} = renderHook(() => {
            const source = useTierValueSource();
            return {
                hasMultipleTiers: source.hasMultipleTiers,
                state: source.useOptions({query: '', selectedValues: []})
            };
        });

        expect(mockUseBrowseTiers).toHaveBeenCalledWith({searchParams: {filter: 'type:paid', limit: '100'}});
        expect(result.current.hasMultipleTiers).toBe(true);
        expect(result.current.state.options).toEqual([
            {
                value: 'active-tier',
                label: 'Active Gold',
                detail: 'active-gold',
                group: 'Active tiers'
            },
            {
                value: 'archived-tier',
                label: 'Archived Gold',
                detail: 'archived-gold',
                group: 'Archived tiers'
            }
        ]);
    });

    it('searches local tier options by group heading', () => {
        mockUseBrowseTiers.mockReturnValue({
            data: {
                tiers: [
                    tier({id: 'active-tier', name: 'Active Gold', slug: 'active-gold', active: true}),
                    tier({id: 'archived-tier', name: 'Archived Gold', slug: 'archived-gold', active: false})
                ],
                isEnd: true
            },
            fetchNextPage: vi.fn(),
            isFetchingNextPage: false,
            isLoading: false
        });

        const {result} = renderHook(() => {
            const source = useTierValueSource();
            return source.useOptions({query: 'archived', selectedValues: []});
        });

        expect(result.current.options).toEqual([
            {
                value: 'archived-tier',
                label: 'Archived Gold',
                detail: 'archived-gold',
                group: 'Archived tiers'
            }
        ]);
    });

    it('loads the next page until the tiers response is complete', () => {
        const fetchNextPage = vi.fn();
        mockUseBrowseTiers.mockReturnValue({
            data: {
                tiers: [tier({id: 'active-tier'})],
                isEnd: false
            },
            fetchNextPage,
            isFetchingNextPage: false,
            isLoading: false
        });

        renderHook(() => useTierValueSource());

        expect(fetchNextPage).toHaveBeenCalledOnce();
    });

    it('does not load another page while a tiers page is already loading', () => {
        const fetchNextPage = vi.fn();
        mockUseBrowseTiers.mockReturnValue({
            data: {
                tiers: [tier({id: 'active-tier'})],
                isEnd: false
            },
            fetchNextPage,
            isFetchingNextPage: true,
            isLoading: false
        });

        renderHook(() => useTierValueSource());

        expect(fetchNextPage).not.toHaveBeenCalled();
    });
});
