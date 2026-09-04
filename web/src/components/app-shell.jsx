import { Activity, RefreshCw, Settings2, Wifi, WifiOff } from 'lucide-react';
import { Link } from 'react-aria-components';
import { Button } from './ui/button';
import { buttonVariants } from './ui/button-variants';
import { cn } from '../lib/utils';
import { formatDateTime, isSnapshotMode } from '../data';

const navigation = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'accounts', label: 'Accounts', icon: Settings2 },
];

export function AppShell({ route, onRefresh, isRefreshing, updatedAt, children }) {
  const snapshot = isSnapshotMode();

  return (
    <div className="min-h-svh bg-background text-foreground md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="border-b border-border bg-sidebar md:sticky md:top-0 md:flex md:h-svh md:flex-col md:border-r md:border-b-0">
        <div className="flex h-16 items-center gap-3 border-b border-border px-4 md:h-[72px]">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-xs font-extrabold tracking-tight text-primary-foreground shadow-sm">
            ZF
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">zFrontier</p>
            <p className="truncate text-xs text-muted-foreground">Crawler operations</p>
          </div>
        </div>

        <nav aria-label="Primary" className="flex gap-1 overflow-x-auto p-2 md:flex-1 md:flex-col md:p-3">
          {navigation.map((item) => {
            const Icon = item.icon;
            const current = route === item.id;
            return (
              <Link
                key={item.id}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  buttonVariants({ variant: 'ghost' }),
                  'min-w-max justify-start px-3 text-muted-foreground md:w-full',
                  current && 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs hover:bg-sidebar-accent',
                )}
                href={`#${item.id}`}
                onPress={() => requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden border-t border-border p-4 md:block">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            {snapshot ? <WifiOff aria-hidden="true" className="mt-0.5 size-3.5" /> : <Wifi aria-hidden="true" className="mt-0.5 size-3.5 text-success" />}
            <div>
              <p className="font-medium text-foreground">{snapshot ? 'Snapshot mode' : 'Server connected'}</p>
              <p className="mt-0.5 leading-5">{snapshot ? 'Read-only local report' : 'SQLite data is live'}</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-sticky flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm md:h-[72px] md:px-6 lg:px-8">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-muted-foreground">
              {updatedAt ? `Updated ${formatDateTime(updatedAt)}` : 'Crawler workspace'}
            </p>
          </div>
          <Button
            aria-label="Refresh crawler data"
            isDisabled={snapshot || isRefreshing}
            onPress={onRefresh}
            size="sm"
            variant="outline"
          >
            <RefreshCw aria-hidden="true" className={cn(isRefreshing && 'animate-spin')} />
            <span className="hidden sm:inline">{isRefreshing ? 'Refreshing' : 'Refresh'}</span>
          </Button>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
