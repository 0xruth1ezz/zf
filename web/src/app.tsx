import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { AppShell } from './components/app-shell';
import { AccountColorProvider } from './components/account-badge';
import { Button } from './components/ui/button';
import { ActivityPage } from './pages/activity-page';
import { AccountsPage } from './pages/accounts-page';
import { MessagesPage } from './pages/messages-page';
import { LoginPage } from './pages/login-page';
import { fetchDashboard, isSnapshotMode } from './data';
import { useUrlFilters } from './lib/url-filters';
import type { Route } from './types';

function subscribeToRoute(callback: () => void) {
  window.addEventListener('hashchange', callback);
  window.addEventListener('popstate', callback);
  return () => {
    window.removeEventListener('hashchange', callback);
    window.removeEventListener('popstate', callback);
  };
}

function currentRoute(): Route {
  const route = window.location.hash.slice(1);
  if (route === 'accounts' || route === 'activity' || route === 'messages') return route;
  if (window.location.pathname.startsWith('/messages')) return 'messages';
  return window.location.pathname.startsWith('/config') || window.location.pathname.startsWith('/accounts')
    ? 'accounts'
    : 'activity';
}

function useRoute() {
  return useSyncExternalStore<Route>(subscribeToRoute, currentRoute, () => 'activity');
}

function LoadingState() {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-6 text-center">
      <div>
        <div className="mx-auto grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
        </div>
        <p className="mt-4 text-sm font-semibold">Loading crawler workspace</p>
        <p className="mt-1 text-sm text-muted-foreground">Reading the latest SQLite records…</p>
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-6 text-center">
      <div className="max-w-md rounded-lg border border-destructive/25 bg-card p-6">
        <AlertTriangle aria-hidden="true" className="mx-auto size-7 text-destructive" />
        <h1 className="mt-3 text-base font-semibold">Crawler data is unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{error.message}</p>
        <Button className="mt-4" onPress={onRetry} variant="outline">
          <RefreshCw aria-hidden="true" /> Try again
        </Button>
      </div>
    </div>
  );
}

export function App() {
  if (window.location.pathname === '/login') return <LoginPage />;
  return <Workspace />;
}

function Workspace() {
  const route = useRoute();
  const [filters, setFilters] = useUrlFilters();
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboard,
    refetchInterval: isSnapshotMode() ? false : 15 * 60 * 1000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  if (dashboard.isPending) return <LoadingState />;
  if (dashboard.isError && !dashboard.data) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;

  const accountIds = [...new Set([
    ...dashboard.data.accounts.map((account) => account.id),
    ...[
      ...dashboard.data.records, ...dashboard.data.signIns,
      ...(dashboard.data.messages || []), ...(dashboard.data.messageSync || []),
    ].map((item) => item.accountId),
    ...(filters.account === 'all' ? [] : [filters.account]),
  ])].sort();
  const pageProps = { data: dashboard.data, filters, setFilters, accountIds };

  return (
    <AccountColorProvider data={dashboard.data}>
      <AppShell
        isRefreshing={dashboard.isFetching}
        onRefresh={() => dashboard.refetch()}
        route={route}
        updatedAt={dashboard.data.generatedAt}
        unreadCount={(dashboard.data.messages || [])
          .filter((message) => filters.account === 'all' || message.accountId === filters.account)
          .reduce((count, message) => count + message.unreadCount, 0)}
      >
        {dashboard.isError ? <p role="alert" className="mb-4 text-sm text-destructive">Refresh failed. Showing the last loaded data.</p> : null}
        {route === 'accounts' ? <AccountsPage data={dashboard.data} />
          : route === 'messages' ? <MessagesPage {...pageProps} />
            : <ActivityPage {...pageProps} />}
      </AppShell>
    </AccountColorProvider>
  );
}
