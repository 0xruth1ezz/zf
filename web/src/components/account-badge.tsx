import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { DashboardPayload } from '../types';
import { cn } from '../lib/utils';

const AccountColors = createContext<ReadonlyMap<string, number>>(new Map());

export function AccountColorProvider({ data, children }: { data: DashboardPayload; children: ReactNode }) {
  const colors = useMemo(() => {
    // Assign from the full roster in creation order, never from a filtered page.
    const accounts = [...(data.accounts || [])].sort((left, right) =>
      (left.createdAt || '').localeCompare(right.createdAt || '') || left.id.localeCompare(right.id));
    const historicalIds = [...new Set([
      ...(data.records || []), ...(data.signIns || []),
      ...(data.messages || []), ...(data.messageSync || []),
    ].map((row) => row.accountId).filter(Boolean))].sort();
    const ids = [...new Set([...accounts.map((account) => account.id), ...historicalIds])];
    const assigned = new Map<string, number>();
    const used = new Set<number>();
    for (const id of ids) {
      // Keep each account's original black/red/yellow preference when available.
      const preferred = Array.from(id).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 3;
      const tone = [preferred, (preferred + 1) % 3, (preferred + 2) % 3]
        .find((candidate) => !used.has(candidate)) ?? assigned.size;
      assigned.set(id, tone);
      used.add(tone);
    }
    return assigned;
  }, [data]);

  return <AccountColors value={colors}>{children}</AccountColors>;
}

export function AccountBadge({ accountId, className }: { accountId: string; className?: string }) {
  const colors = useContext(AccountColors);
  const tone = colors.get(accountId) ?? 0;
  const style: (CSSProperties & { '--account-hue': number }) | undefined = tone < 3
    ? undefined : { '--account-hue': (245 + (tone - 3) * 137.508) % 360 };
  return (
    <code
      className={cn('code-label', className)}
      data-kind="account"
      data-tone={tone}
      style={style}
    >
      {accountId}
    </code>
  );
}
