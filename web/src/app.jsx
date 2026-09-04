import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { AppShell } from './components/app-shell';
import { Button } from './components/ui/button';
import { ActivityPage } from './pages/activity-page';
import { AccountsPage } from './pages/accounts-page';
import { fetchDashboard } from './data';

function subscribeToRoute(callback) {
  window.addEventListener('hashchange', callback);
  window.addEventListener('popstate', callback);
  return () => {
    window.removeEventListener('hashchange', callback);
    window.removeEventListener('popstate', callback);
  };
}

function currentRoute() {
  const route = window.location.hash.slice(1);
  if (route === 'accounts' || route === 'activity') return route;
  return window.location.pathname.startsWith('/config') || window.location.pathname.startsWith('/accounts')
    ? 'accounts'
    : 'activity';
}

function useRoute() {
  return useSyncExternalStore(subscribeToRoute, currentRoute, () => 'activity');
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

function ErrorState({ error, onRetry }) {
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
  const route = useRoute();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });

  if (dashboard.isPending) return <LoadingState />;
  if (dashboard.isError) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;

  return (
    <AppShell
      isRefreshing={dashboard.isFetching}
      onRefresh={() => dashboard.refetch()}
      route={route}
      updatedAt={dashboard.data.generatedAt}
    >
      {route === 'accounts' ? <AccountsPage data={dashboard.data} /> : <ActivityPage data={dashboard.data} />}
    </AppShell>
  );
}
