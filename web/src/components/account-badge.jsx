import { createContext, useContext, useMemo } from 'react';
import { cn } from '../lib/utils';

const AccountColors = createContext(new Map());

export function AccountColorProvider({ data, children }) {
  const colors = useMemo(() => {
    // Assign from the full roster in creation order, never from a filtered page.
    const accounts = [...(data.accounts || [])].sort((left, right) =>
      (left.createdAt || '').localeCompare(right.createdAt || '') || left.id.localeCompare(right.id));
    const historicalIds = [...new Set([
      ...(data.records || []), ...(data.signIns || []),
      ...(data.messages || []), ...(data.messageSync || []),
    ].map((row) => row.accountId).filter(Boolean))].sort();
    const ids = [...new Set([...accounts.map((account) => account.id), ...historicalIds])];
    const assigned = new Map();
    const used = new Set();
    for (const id of ids) {
      // Keep each account's original black/red/yellow preference when available.
      const preferred = Array.from(id).reduce((sum, character) => sum + character.codePointAt(0), 0) % 3;
      const tone = [preferred, (preferred + 1) % 3, (preferred + 2) % 3]
        .find((candidate) => !used.has(candidate)) ?? assigned.size;
      assigned.set(id, tone);
      used.add(tone);
    }
    return assigned;
  }, [data]);

  return <AccountColors value={colors}>{children}</AccountColors>;
}

export function AccountBadge({ accountId, className }) {
  const colors = useContext(AccountColors);
  const tone = colors.get(accountId) ?? 0;
  return (
    <code
      className={cn('code-label', className)}
      data-kind="account"
      data-tone={tone}
      style={tone < 3 ? undefined : { '--account-hue': (245 + (tone - 3) * 137.508) % 360 }}
    >
      {accountId}
    </code>
  );
}
