import { useState } from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { AccountBadge } from '../components/account-badge';
import { Badge } from '../components/ui/badge';
import { Select, SelectItem } from '../components/ui/select';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { formatDateTime } from '../data';

const PAGE_SIZE = 20;

export function MessagesPage({ data }) {
  const [page, setPage] = useState(0);
  const [account, setAccount] = useState('all');
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
  const accountIds = [...new Set([...sync.map((status) => status.accountId), ...messages.map((message) => message.accountId)])].sort();
  const filteredMessages = messages.filter((message) => account === 'all' || message.accountId === account);
  const filteredSync = sync.filter((status) => account === 'all' || status.accountId === account);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filteredMessages.length / PAGE_SIZE) - 1));
  const rows = filteredMessages.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <>
      <PageHeader title="Private messages" />
      <div className="mb-5 w-full sm:w-56">
        <Select label="Account" selectedKey={account} onSelectionChange={(key) => { setAccount(String(key)); setPage(0); }}>
          <SelectItem id="all">All accounts</SelectItem>
          {accountIds.map((id) => <SelectItem key={id} id={id}>{id}</SelectItem>)}
        </Select>
      </div>
      {filteredSync.length > 0 ? (
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {filteredSync.map((status) => (
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
      {filteredMessages.length === 0 ? (
        <div className="grid min-h-52 place-items-center border-y border-border py-10 text-center">
          <div>
            <Mail aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-semibold">{filteredSync.some((status) => status.fetchedAt) ? 'No private messages' : 'Waiting for the first message fetch'}</h2>
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
          <Pagination label="Private messages" page={currentPage} onPageChange={setPage} pageSize={PAGE_SIZE} total={filteredMessages.length} />
        </>
      )}
    </>
  );
}
