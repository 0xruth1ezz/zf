import { cn } from '../lib/utils';

const ACCOUNT_TONE_COUNT = 3;

function accountTone(accountId) {
  return Array.from(String(accountId)).reduce(
    (hash, character) => hash + character.codePointAt(0),
    0,
  ) % ACCOUNT_TONE_COUNT;
}

export function AccountBadge({ accountId, className }) {
  return (
    <code
      className={cn('code-label', className)}
      data-kind="account"
      data-tone={accountTone(accountId)}
    >
      {accountId}
    </code>
  );
}
