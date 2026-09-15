import { useState } from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { AccountBadge } from '../components/account-badge';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { formatDateTime } from '../data';

const PAGE_SIZE = 20;

export function MessagesPage({ data }) {
  const [page, setPage] = useState(0);
  const messages = data.messages || [];
  const syncByAccount = new Map((data.messageSync || []).map((status) => [status.accountId, status]));
  for (const account of data.accounts || []) {
    syncByAccount.set(account.id, {
      accountId: account.id,
      fetchedAt: '',
      error: '',
      ...syncByAccount.get(account.id),
      enabled: account.enabled,
    });
  }
  const sync = [...syncByAccount.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(messages.length / PAGE_SIZE) - 1));
  const rows = messages.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <>
      <PageHeader title="Private messages" />
      {sync.length > 0 ? (
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {sync.map((status) => (
            <p key={status.accountId} className="flex flex-wrap items-center gap-2">
              <AccountBadge accountId={status.accountId} />
              <span>Last fetched: {formatDateTime(status.fetchedAt)}</span>
              {status.enabled === false ? <span>Account disabled</span>
                : status.error ? <span className="text-destructive" role="status">Fetch failed. Retrying on the next check.</span>
                  : !status.fetchedAt ? <span>Waiting for first fetch</span> : null}
            </p>
          ))}
        </div>
      ) : null}
      {messages.length === 0 ? (
        <div className="grid min-h-52 place-items-center border-y border-border py-10 text-center">
          <div>
            <Mail aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-semibold">{sync.some((status) => status.fetchedAt) ? 'No private messages' : 'Waiting for the first message fetch'}</h2>
          </div>
        </div>
      ) : (
        <>
          <ul aria-label="Private messages" className="divide-y divide-border border-y border-border">
            {rows.map((message) => (
              <li key={`${message.accountId}:${message.messageId}`}>
                <a href={message.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-start gap-3 px-2 py-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <Mail aria-hidden="true" className={`mt-1 size-4 shrink-0 ${message.unreadCount > 0 ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`break-words text-sm ${message.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>{message.sender}</span>
                      <AccountBadge accountId={message.accountId} />
                      {message.unreadCount > 0 ? <Badge variant="info">{message.unreadCount} unread</Badge> : null}
                    </div>
                    <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{message.preview || 'No preview'}</p>
                    {message.sentAt ? <p className="mt-1 text-xs text-muted-foreground">{message.sentAt}</p> : null}
                  </div>
                  <ExternalLink aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ul>
          <Pagination label="Private messages" page={currentPage} onPageChange={setPage} pageSize={PAGE_SIZE} total={messages.length} />
        </>
      )}
    </>
  );
}
