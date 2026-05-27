import {MemberFactory, TierFactory, createMemberFactory, createTierFactory} from '@/data-factory';
import {MembersListPage} from '@/admin-pages';
import {SettingsService} from '@/helpers/services/settings/settings-service';
import {expect, test} from '@/helpers/playwright';
import {usePerTestIsolation} from '@/helpers/playwright/isolation';

usePerTestIsolation();

test.describe('Ghost Admin - Members Tier Filter Search', () => {
    let memberFactory: MemberFactory;
    let tierFactory: TierFactory;

    test.beforeEach(async ({page}) => {
        memberFactory = createMemberFactory(page.request);
        tierFactory = createTierFactory(page.request);
    });

    test('filters tier options by slug in the search dropdown', async ({page}) => {
        const settingsService = new SettingsService(page.request);
        await settingsService.setStripeConnected();

        const firstTier = await tierFactory.getFirstPaidTier();
        const secondTier = await tierFactory.create({name: 'Silver Tier'});

        await memberFactory.createMany([
            {name: 'Paid Member', email: 'paid@example.com', status: 'comped', tiers: [{id: firstTier.id}]},
            {name: 'Silver Member', email: 'silver@example.com', status: 'comped', tiers: [{id: secondTier.id}]},
            {name: 'Free Member', email: 'free@example.com'}
        ]);

        const membersPage = new MembersListPage(page);
        await membersPage.goto();
        await page.reload({waitUntil: 'load'});
        await expect(membersPage.memberRows).toHaveCount(3);

        await membersPage.addSearchableFilter('Membership tier', secondTier.slug, secondTier.name);
        await expect(membersPage.memberRows).toHaveCount(1);
        await expect(membersPage.getMemberByName('Silver Member')).toBeVisible();
    });

    test('groups active and archived tier options and filters by archived tier', async ({page}) => {
        const settingsService = new SettingsService(page.request);
        await settingsService.setStripeConnected();

        const activeTier = await tierFactory.create({name: 'Active Gold'});
        const archivedTier = await tierFactory.create({name: 'Legacy Gold'});

        await memberFactory.createMany([
            {name: 'Active Member', email: 'active@example.com', status: 'comped', tiers: [{id: activeTier.id}]},
            {name: 'Archived Member', email: 'archived@example.com', status: 'comped', tiers: [{id: archivedTier.id}]},
            {name: 'Free Member', email: 'free@example.com'}
        ]);

        const archiveResponse = await page.request.put(`/ghost/api/admin/tiers/${archivedTier.id}/`, {
            data: {
                tiers: [{...archivedTier, active: false}]
            }
        });
        expect(archiveResponse.ok()).toBe(true);

        const membersPage = new MembersListPage(page);
        await membersPage.goto();
        await page.reload({waitUntil: 'load'});
        await expect(membersPage.memberRows).toHaveCount(3);

        await membersPage.filterButton.click();
        await page.getByRole('option', {name: 'Membership tier', exact: true}).click();

        await expect(page.getByText('Active tiers')).toBeVisible();
        await expect(page.getByText('Archived tiers')).toBeVisible();

        await page.getByPlaceholder('Search membership tier...').fill('archived');
        await expect(page.getByRole('option', {name: /Legacy Gold/})).toBeVisible();
        await expect(page.getByRole('option', {name: /Active Gold/})).toBeHidden();

        await page.getByRole('option', {name: /Legacy Gold/}).click();

        await expect(membersPage.memberRows).toHaveCount(1);
        await expect(membersPage.getMemberByName('Archived Member')).toBeVisible();
        await expect(membersPage.getMemberByName('Archived Member')).toContainText('Legacy Gold');
    });
});
