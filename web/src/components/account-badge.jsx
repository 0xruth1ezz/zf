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
    // A golden-angle step spreads new accounts around the color wheel without
    // cycling back to the same three colors.
    return new Map(ids.map((id, index) => [id, (245 + index * 137.508) % 360]));
  }, [data]);

  return <AccountColors value={colors}>{children}</AccountColors>;
}

export function AccountBadge({ accountId, className }) {
  const colors = useContext(AccountColors);
  return (
    <code
      className={cn('code-label', className)}
      data-kind="account"
      style={{ '--account-hue': colors.get(accountId) ?? 245 }}
    >
      {accountId}
    </code>
  );
}
