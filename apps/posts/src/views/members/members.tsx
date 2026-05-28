import MainLayout from '@components/layout/main-layout';
import MembersActions from './components/members-actions';
import MembersEmptyState from './components/members-empty-state';
import MembersFilters from './components/members-filters';
import MembersHeaderSearch from './components/members-header-search';
import MembersHelpCards from './components/members-help-cards';
import MembersList from './components/members-list';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Banner, Button, EmptyIndicator, LoadingIndicator} from '@tryghost/shade/components';
import {Config, useBrowseConfig} from '@tryghost/admin-x-framework/api/config';
import {FilterBar, PageHeader} from '@tryghost/shade/patterns';
import {ListPage} from '@tryghost/shade/page-templates';
import {LucideIcon, cn, formatNumber} from '@tryghost/shade/utils';
import {MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER, buildUserWithDismissedMultipleActiveStripeCustomersBanner, getMultipleActiveStripeCustomersBannerPreference, isMultipleActiveStripeCustomersFilter} from './multiple-active-stripe-customers';
import {Setting, checkStripeEnabled, getSettingValue, useBrowseSettings} from '@tryghost/admin-x-framework/api/settings';
import {buildMemberListSearchParams, getMemberActiveColumns} from './member-query-params';
import {buildMembersUrl} from './member-route';
import {canBulkDeleteMembers, shouldShowMembersLoading} from './members-view-state';
import {canManageMembers, useEditUser} from '@tryghost/admin-x-framework/api/users';
import {getSiteTimezone} from '@src/utils/get-site-timezone';
import {shouldDelayMembersDateFilterHydration, useMembersFilterState} from './hooks/use-members-filter-state';
import {toast} from 'sonner';
import {useActiveMemberView, useMemberViews} from './hooks/use-member-views';
import {useBrowseMembers, useBrowseMembersInfinite} from '@tryghost/admin-x-framework/api/members';
import {useCurrentUser} from '@tryghost/admin-x-framework/api/current-user';
import {useDebounce} from 'use-debounce';
import {useLocation, useNavigate, useSearchParams} from 'react-router';

const SEARCH_DEBOUNCE_MS = 250;
const MEMBERS_HELP_CARDS_LIMIT = 6;

const MembersPage: React.FC<{timezone: string; membershipsEnabled: boolean; settings: Setting[]; config: Config}> = ({timezone, membershipsEnabled, settings, config}) => {
    const headerRef = useRef<HTMLDivElement | null>(null);
    const setHeaderContentRef = useCallback((node: HTMLDivElement | null) => {
        headerRef.current = node?.closest('[data-list-page="header"]') as HTMLDivElement | null;
    }, []);
    const multipleSubsFilterEnabled = config.labs?.multipleSubsFilter === true;
    const {filters, nql, search, setFilters, setSearch, hasFilterOrSearch, clearAll} = useMembersFilterState(timezone, {
        preserveMultipleActiveStripeCustomersFilter: multipleSubsFilterEnabled
    });
    const location = useLocation();
    const navigate = useNavigate();
    const {data: currentUser} = useCurrentUser();
    const {mutateAsync: editUser, isLoading: isDismissingMultipleActiveStripeCustomersBanner} = useEditUser();
    const savedViews = useMemberViews();
    const activeView = useActiveMemberView(savedViews, nql);
    const [showMobileSearch, setShowMobileSearch] = useState(false);
    const [mobileSearchOpenedByUser, setMobileSearchOpenedByUser] = useState(false);
    const [searchInput, setSearchInput] = useState(search);
    const [debouncedSearch] = useDebounce(searchInput, SEARCH_DEBOUNCE_MS);

    const emailAnalyticsEnabled = config.emailAnalytics === true;
    const hasStripeEnabled = checkStripeEnabled(settings, config);
    const canManageMemberList = currentUser ? canManageMembers(currentUser) : false;
    const isViewingMultipleActiveStripeCustomersFilter = isMultipleActiveStripeCustomersFilter(nql);
    const shouldConsiderMultipleActiveStripeCustomersBanner = !search && (!nql || isViewingMultipleActiveStripeCustomersFilter);

    const [optimisticDismissedMultipleActiveStripeCustomersCount, setOptimisticDismissedMultipleActiveStripeCustomersCount] = useState<number | null>(null);

    const {
        data: multipleActiveStripeCustomersData
    } = useBrowseMembers({
        searchParams: {
            filter: MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER,
            limit: '1',
            fields: 'id',
            order: 'id'
        },
        defaultErrorHandler: false,
        enabled: multipleSubsFilterEnabled && canManageMemberList && hasStripeEnabled && shouldConsiderMultipleActiveStripeCustomersBanner,
        refetchOnMount: 'always',
        staleTime: 0
    });

    const multipleActiveStripeCustomersCount = multipleActiveStripeCustomersData?.meta?.pagination?.total ?? 0;
    const multipleActiveStripeCustomersBannerPreference = useMemo(() => {
        return getMultipleActiveStripeCustomersBannerPreference(currentUser?.accessibility);
    }, [currentUser?.accessibility]);
    const dismissedMultipleActiveStripeCustomersCount = optimisticDismissedMultipleActiveStripeCustomersCount
        ?? multipleActiveStripeCustomersBannerPreference.dismissedCount
        ?? 0;
    const shouldShowMultipleActiveStripeCustomersBanner = multipleSubsFilterEnabled
        && shouldConsiderMultipleActiveStripeCustomersBanner
        && (
            isViewingMultipleActiveStripeCustomersFilter
            || multipleActiveStripeCustomersCount > dismissedMultipleActiveStripeCustomersCount
        );
    const canDismissMultipleActiveStripeCustomersBanner = !isViewingMultipleActiveStripeCustomersFilter;

    const activeColumns = useMemo(() => {
        return getMemberActiveColumns(filters);
    }, [filters]);

    const canBulkDelete = useMemo(() => {
        return canBulkDeleteMembers(filters, nql);
    }, [filters, nql]);

    const searchParams = useMemo(() => {
        return buildMemberListSearchParams({
            filters,
            nql,
            search
        });
    }, [filters, nql, search]);

    const {
        data,
        isError,
        isFetching,
        isFetchingNextPage,
        refetch,
        fetchNextPage,
        hasNextPage
    } = useBrowseMembersInfinite({
        searchParams,
        keepPreviousData: true
    });

    const shouldShowLoading = shouldShowMembersLoading({
        isFetching,
        isFetchingNextPage
    });

    const totalMembers = data?.meta?.pagination?.total ?? 0;
    const hasFilters = filters.length > 0;
    const shouldShowMobileSearchRow = showMobileSearch;
    const shouldShowFiltersRow = hasFilters;
    const shouldShowMembersHelpCards = !hasFilterOrSearch && !shouldShowLoading && !isError && totalMembers < MEMBERS_HELP_CARDS_LIMIT;

    useEffect(() => {
        setSearchInput(search);
    }, [search]);

    useEffect(() => {
        if (debouncedSearch !== search) {
            setSearch(debouncedSearch);
        }
    }, [debouncedSearch, search, setSearch]);

    useEffect(() => {
        const dismissedCount = multipleActiveStripeCustomersBannerPreference.dismissedCount;

        if (
            !currentUser
            || optimisticDismissedMultipleActiveStripeCustomersCount !== null
            || isDismissingMultipleActiveStripeCustomersBanner
            || dismissedCount === undefined
            || multipleActiveStripeCustomersData === undefined
            || multipleActiveStripeCustomersCount >= dismissedCount
        ) {
            return;
        }

        setOptimisticDismissedMultipleActiveStripeCustomersCount(multipleActiveStripeCustomersCount);

        editUser(buildUserWithDismissedMultipleActiveStripeCustomersBanner(
            currentUser,
            multipleActiveStripeCustomersCount,
            multipleActiveStripeCustomersBannerPreference.dismissedAt ?? new Date().toISOString()
        )).then(() => {
            setOptimisticDismissedMultipleActiveStripeCustomersCount(null);
        }).catch((error) => {
            setOptimisticDismissedMultipleActiveStripeCustomersCount(null);
            // This keeps the preference in sync opportunistically; failing to sync should not interrupt the member list.
            // eslint-disable-next-line no-console
            console.log('Unable to update multiple active Stripe customers banner dismissed count', error);
        });
    }, [
        currentUser,
        editUser,
        isDismissingMultipleActiveStripeCustomersBanner,
        multipleActiveStripeCustomersBannerPreference.dismissedAt,
        multipleActiveStripeCustomersBannerPreference.dismissedCount,
        multipleActiveStripeCustomersCount,
        multipleActiveStripeCustomersData,
        optimisticDismissedMultipleActiveStripeCustomersCount
    ]);

    const handleMobileSearchToggle = () => {
        if (showMobileSearch) {
            setShowMobileSearch(false);
            setMobileSearchOpenedByUser(false);
            return;
        }

        setMobileSearchOpenedByUser(true);
        setShowMobileSearch(true);
    };

    const handleViewMultipleActiveStripeCustomers = () => {
        navigate(buildMembersUrl({filter: MULTIPLE_ACTIVE_STRIPE_CUSTOMERS_FILTER}));
    };

    const handleDismissMultipleActiveStripeCustomersBanner = () => {
        if (!currentUser || isDismissingMultipleActiveStripeCustomersBanner) {
            return;
        }

        const dismissedCount = multipleActiveStripeCustomersCount;
        const previousDismissedCount = optimisticDismissedMultipleActiveStripeCustomersCount;

        setOptimisticDismissedMultipleActiveStripeCustomersCount(dismissedCount);

        editUser(buildUserWithDismissedMultipleActiveStripeCustomersBanner(
            currentUser,
            dismissedCount,
            new Date().toISOString()
        )).then(() => {
            setOptimisticDismissedMultipleActiveStripeCustomersCount(null);
        }).catch(() => {
            setOptimisticDismissedMultipleActiveStripeCustomersCount(previousDismissedCount);
            toast.error('Unable to dismiss notification. Please try again.');
        });
    };

    const filtersClassName = 'flex-col gap-4 lg:flex-row lg:items-center sidebar:gap-6 lg:gap-6';

    return (
        <MainLayout>
            <ListPage data-testid="members-page">
                <ListPage.Header className="py-4 sidebar:py-6">
                    <div ref={setHeaderContentRef} className="flex flex-col gap-4 sidebar:gap-6">
                        <PageHeader
                            blurredBackground={false}
                            sticky={false}
                        >
                            <PageHeader.Left>
                                <PageHeader.Title>
                                    Members{' '}
                                    {!shouldShowLoading && (
                                        <PageHeader.Count className="hidden sm:inline">
                                            {formatNumber(totalMembers)}
                                        </PageHeader.Count>
                                    )}
                                </PageHeader.Title>
                            </PageHeader.Left>
                            <PageHeader.Actions>
                                <PageHeader.ActionGroup className="ml-auto flex-wrap justify-end sm:ml-0 sm:flex-nowrap">
                                    <div className="hidden lg:flex">
                                        <MembersHeaderSearch
                                            search={searchInput}
                                            onSearchChange={setSearchInput}
                                        />
                                    </div>
                                    <Button
                                        aria-label={showMobileSearch ? 'Hide member search' : 'Show member search'}
                                        className={cn('lg:hidden', showMobileSearch && 'bg-secondary hover:bg-secondary')}
                                        variant="outline"
                                        onClick={handleMobileSearchToggle}
                                    >
                                        <LucideIcon.Search className="size-4" />
                                    </Button>
                                    {!hasFilters && (
                                        <MembersFilters
                                            activeView={activeView}
                                            filters={filters}
                                            iconOnly={true}
                                            nql={nql}
                                            savedViews={savedViews}
                                            onFiltersChange={setFilters}
                                        />
                                    )}
                                    <MembersActions
                                        canBulkDelete={canBulkDelete}
                                        hasFilterOrSearch={hasFilterOrSearch}
                                        memberCount={totalMembers}
                                        nql={nql}
                                        search={search}
                                        onImportComplete={() => {
                                            void refetch();
                                        }}
                                    />
                                </PageHeader.ActionGroup>
                            </PageHeader.Actions>
                        </PageHeader>

                        {(shouldShowFiltersRow || shouldShowMobileSearchRow) && (
                            <FilterBar className={cn(filtersClassName, !shouldShowFiltersRow && 'lg:hidden')}>
                                {shouldShowMobileSearchRow && (
                                    <div className="w-full lg:hidden">
                                        <MembersHeaderSearch
                                            ariaLabel="Search members mobile"
                                            autoFocus={mobileSearchOpenedByUser}
                                            search={searchInput}
                                            onSearchChange={setSearchInput}
                                        />
                                    </div>
                                )}
                                {shouldShowFiltersRow && (
                                    <MembersFilters
                                        activeView={activeView}
                                        filters={filters}
                                        nql={nql}
                                        savedViews={savedViews}
                                        onFiltersChange={setFilters}
                                    />
                                )}
                            </FilterBar>
                        )}
                        {shouldShowMultipleActiveStripeCustomersBanner && (
                            <Banner
                                role="status"
                                variant="warning"
                                {...(canDismissMultipleActiveStripeCustomersBanner ? {
                                    dismissible: true as const,
                                    onDismiss: handleDismissMultipleActiveStripeCustomersBanner
                                } : {
                                    dismissible: false as const
                                })}
                            >
                                <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="text-sm font-medium">
                                        {formatNumber(multipleActiveStripeCustomersCount)} {multipleActiveStripeCustomersCount === 1 ? 'member' : 'members'} with active subscriptions across multiple Stripe customers were found.
                                    </div>
                                    {canDismissMultipleActiveStripeCustomersBanner && (
                                        <Button size="sm" variant="outline" onClick={handleViewMultipleActiveStripeCustomers}>
                                            View members
                                        </Button>
                                    )}
                                </div>
                            </Banner>
                        )}
                    </div>
                </ListPage.Header>
                <ListPage.Body>
                    {shouldShowLoading ? (
                        <div className="flex flex-1 items-center justify-center">
                            <LoadingIndicator size="lg" />
                        </div>
                    ) : isError ? (
                        <div className="mb-16 flex flex-1 flex-col items-center justify-center">
                            <h2 className="mb-2 text-xl font-medium">
                                Error loading members
                            </h2>
                            <p className="mb-4 text-muted-foreground">
                                Please reload the page to try again
                            </p>
                            <Button onClick={() => window.location.reload()}>
                                Reload page
                            </Button>
                        </div>
                    ) : !data?.members.length ? (
                        hasFilterOrSearch ? (
                            <div className="flex flex-1 flex-col items-center justify-center">
                                <EmptyIndicator
                                    actions={
                                        <Button
                                            variant="outline"
                                            onClick={() => clearAll({replace: false})}
                                        >
                                            Show all members
                                        </Button>
                                    }
                                    title="No matching members found."
                                >
                                    <LucideIcon.Users />
                                </EmptyIndicator>
                            </div>
                        ) : (
                            <MembersEmptyState membershipsEnabled={membershipsEnabled} onMemberCreated={async () => {
                                await refetch();
                            }} />
                        )
                    ) : (
                        <MembersList
                            activeColumns={activeColumns}
                            backPath={`${location.pathname}${location.search}`}
                            fetchNextPage={fetchNextPage}
                            hasNextPage={hasNextPage}
                            isFetchingNextPage={isFetchingNextPage}
                            isLoading={isFetching && !isFetchingNextPage}
                            items={data.members}
                            pageHeaderRef={headerRef}
                            showEmailOpenRate={emailAnalyticsEnabled}
                            timezone={timezone}
                            totalItems={totalMembers}
                        />
                    )}
                    {shouldShowMembersHelpCards && <MembersHelpCards />}
                </ListPage.Body>
            </ListPage>
        </MainLayout>
    );
};

const Members: React.FC = () => {
    const [searchParams] = useSearchParams();
    const {data: settingsData, isLoading: isSettingsLoading} = useBrowseSettings({});
    const {data: configData, isLoading: isConfigLoading} = useBrowseConfig();
    const filterParam = searchParams.get('filter') ?? undefined;
    const hasResolvedSettings = Boolean(settingsData?.settings);
    const shouldDelayHydration = shouldDelayMembersDateFilterHydration(filterParam, hasResolvedSettings, isSettingsLoading);

    if (isSettingsLoading || isConfigLoading || !settingsData?.settings || !configData?.config || shouldDelayHydration) {
        return (
            <MainLayout>
                <ListPage>
                    <ListPage.Header className="py-4 sidebar:py-6">
                        <PageHeader
                            blurredBackground={false}
                            sticky={false}
                        >
                            <PageHeader.Left>
                                <PageHeader.Title>Members</PageHeader.Title>
                            </PageHeader.Left>
                        </PageHeader>
                    </ListPage.Header>
                    <ListPage.Body>
                        <div className="flex flex-1 items-center justify-center">
                            <LoadingIndicator size="lg" />
                        </div>
                    </ListPage.Body>
                </ListPage>
            </MainLayout>
        );
    }

    const timezone = getSiteTimezone(settingsData.settings);
    const membersSignupAccess = getSettingValue<string>(settingsData.settings, 'members_signup_access');
    const membershipsEnabled = membersSignupAccess !== 'none';

    return <MembersPage config={configData.config} membershipsEnabled={membershipsEnabled} settings={settingsData.settings} timezone={timezone} />;
};

export default Members;
