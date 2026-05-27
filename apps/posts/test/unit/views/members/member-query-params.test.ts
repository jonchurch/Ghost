import {describe, expect, it} from 'vitest';
import {
    getActiveColumnValue,
    getMemberActiveColumns
} from '../../../../src/views/members/member-query-params';
import type {FilterPredicate} from '../../../../src/views/filters/filter-types';
import type {Member} from '@tryghost/admin-x-framework/api/members';

describe('member-query-params tier filters', () => {
    it('adds the tiers table column for tier filters', () => {
        const filters: FilterPredicate[] = [
            {
                id: '1',
                field: 'tier_id',
                operator: 'is-any',
                values: ['archived-tier']
            }
        ];

        expect(getMemberActiveColumns(filters)).toEqual([
            {
                key: 'tiers',
                label: 'Tiers',
                include: 'tiers'
            }
        ]);
    });

    it('uses the member tier name for the tiers table column', () => {
        const member = {
            tiers: [
                {
                    id: 'archived-tier',
                    name: 'Archived Gold',
                    slug: 'archived-gold',
                    active: false,
                    type: 'paid'
                }
            ]
        } as Member;

        expect(getActiveColumnValue({
            key: 'tiers',
            label: 'Tiers',
            include: 'tiers'
        }, member, 'UTC')).toEqual({
            text: 'Archived Gold'
        });
    });
});
