import { useState } from 'react';
import { ExternalLink, Mail, SlidersHorizontal } from 'lucide-react';
import { AccountBadge } from '../components/account-badge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/field';
import { Select, SelectItem } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { formatDateTime } from '../data';

const PAGE_SIZE = 20;

function MessageEmptyState({ hasAccounts, hasMessages, search, unreadOnly, sync, onReset }) {
  const hasFilters = Boolean(search || unreadOnly);
  const allDisabled = sync.length > 0 && sync.every((status) => status.enabled === false);
  const hasFetchError = sync.some((status) => status.enabled !== false && status.error);
  let title = 'No private messages';
  let description = 'No conversations were found in the last fetch. New messages will appear here after the next check.';

  if (search || (unreadOnly && hasMessages)) {
    title = unreadOnly && !search ? 'No unread messages' : 'No matching conversations';
    description = 'Clear the filters to see more conversations.';
  } else if (!hasAccounts) {
    title = 'No accounts configured';
    description = 'Add an account to start fetching private messages from zFrontier.';
  } else if (allDisabled) {
    title = 'Message fetching is paused';
    description = 'Enable an account to fetch new messages. Saved conversations will remain available here.';
  } else if (!sync.some((status) => status.fetchedAt)) {
    title = hasFetchError ? 'Messages could not be fetched' : 'Waiting for the first message fetch';
    description = hasFetchError
      ? 'The crawler will retry on the next check. Review the account fetch status below.'
      : 'Conversations will appear here after the crawler checks this account’s inbox.';
  }

  return (
    <div className="grid min-h-52 place-items-center rounded-lg border border-dashed border-border bg-muted/25 px-6 py-10 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Mail aria-hidden="true" className="size-4" />
        </div>
        <h3 className="mt-3 text-sm font-semibold text-balance">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground text-pretty">{description}</p>
        {hasFilters ? <Button className="mt-4" onPress={onReset} size="sm" variant="outline">Clear filters</Button> : null}
        {!hasAccounts || allDisabled ? (
          <a className="mt-4 inline-flex min-h-9 items-center text-sm font-semibold underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" href="#accounts">Manage accounts</a>
        ) : null}
      </div>
    </div>
  );
}

function MessageList({ messages }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div aria-hidden="true" className="hidden grid-cols-[104px_minmax(0,1fr)_152px_16px] items-center gap-4 border-b border-border bg-muted/65 px-3 py-3 text-xs font-semibold text-muted-foreground lg:grid">
        <span>Account</span>
        <span>Conversation</span>
        <span>Last message</span>
        <span />
      </div>
      <ul aria-label="Private messages" className="divide-y divide-border">
        {messages.map((message) => (
          <li key={`${message.accountId}:${message.messageId}`}>
            <a href={message.url} target="_blank" rel="noreferrer" className="group grid min-w-0 grid-cols-[minmax(0,1fr)_16px] items-start gap-x-4 gap-y-3 px-3 py-4 transition-colors duration-150 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:grid-cols-[104px_minmax(0,1fr)_152px_16px]">
              <div className="col-start-1 row-start-1 min-w-0 lg:col-start-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className={`min-w-0 [overflow-wrap:anywhere] text-sm underline decoration-border underline-offset-4 group-hover:text-primary group-hover:decoration-primary ${message.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>{message.sender}</span>
                  {message.unreadCount > 0 ? <Badge className="shrink-0 tabular-nums" variant="info">{message.unreadCount} unread</Badge> : null}
                </div>
                <p className="mt-1 line-clamp-2 max-w-[75ch] text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{message.preview || 'No preview available'}</p>
              </div>
              <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center justify-between gap-2 lg:contents">
                <div className="min-w-0 max-w-full lg:col-start-1 lg:row-start-1">
                  <span className="sr-only">Account: </span>
                  <AccountBadge accountId={message.accountId} />
                </div>
                <p className="min-w-0 text-xs leading-5 tabular-nums text-muted-foreground [overflow-wrap:anywhere] lg:col-start-3 lg:row-start-1">
                  <span className="sr-only">Last message: </span>{message.sentAt || 'Not recorded'}
                </p>
              </div>
              <ExternalLink aria-hidden="true" className="col-start-2 row-start-1 mt-0.5 size-3.5 justify-self-end text-muted-foreground lg:col-start-4" />
              <span className="sr-only">Opens on zFrontier in a new tab</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageSync({ sync }) {
  if (sync.length === 0) return null;

  return (
    <section aria-labelledby="message-sync-heading" className="mt-8">
      <h2 id="message-sync-heading" className="text-sm font-semibold">Account fetch status</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Message counts reflect the last successful fetch for each account.</p>
      <ul aria-label="Account fetch status" className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
        {sync.map((status) => (
          <li key={status.accountId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3">
            <div className="w-26 min-w-0"><AccountBadge accountId={status.accountId} /></div>
            <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
              Last fetched: <span className="tabular-nums">{formatDateTime(status.fetchedAt)}</span>
            </p>
            <p className="w-full text-xs leading-5 sm:w-auto">
              {status.enabled === false ? <Badge>Account disabled</Badge>
                : status.error ? <span className="text-destructive" role="status">Fetch failed. Retrying on the next check.</span>
                  : !status.fetchedAt ? <Badge>Waiting for first fetch</Badge>
                    : <Badge variant="success">Fetched</Badge>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MessagesPage({ data }) {
  const [page, setPage] = useState(0);
  const [account, setAccount] = useState('all');
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
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
  const normalizedSearch = search.trim().toLowerCase();
  const accountMessages = messages.filter((message) => account === 'all' || message.accountId === account);
  const filteredMessages = accountMessages.filter((message) => (
    (!unreadOnly || message.unreadCount > 0)
    && (!normalizedSearch || `${message.sender} ${message.preview || ''} ${message.accountId}`.toLowerCase().includes(normalizedSearch))
  ));
  const filteredSync = sync.filter((status) => account === 'all' || status.accountId === account);
  const fetchErrors = filteredSync.filter((status) => status.enabled !== false && status.error).length;
  const unreadCount = filteredMessages.reduce((count, message) => count + message.unreadCount, 0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filteredMessages.length / PAGE_SIZE) - 1));
  const rows = filteredMessages.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function clearFilters() {
    setAccount('all');
    setSearch('');
    setUnreadOnly(false);
    setPage(0);
  }

  return (
    <>
      <PageHeader title="Private messages" description="Review conversations across crawler accounts. Open a conversation on zFrontier to read and reply." />
      <div className="mb-6 rounded-lg border border-border bg-card p-3 shadow-xs">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_220px]">
          <Field
            aria-label="Search messages"
            label="Search"
            inputClassName="placeholder:text-muted-foreground"
            onChange={(value) => { setSearch(value); setPage(0); }}
            placeholder="Sender, message, account…"
            value={search}
          />
          <Select label="Account" selectedKey={account} onSelectionChange={(key) => { setAccount(String(key)); setPage(0); }}>
            <SelectItem id="all">All accounts</SelectItem>
            {accountIds.map((id) => <SelectItem key={id} id={id}>{id}</SelectItem>)}
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <Switch isSelected={unreadOnly} onChange={(value) => { setUnreadOnly(value); setPage(0); }}>Unread only</Switch>
          <Button onPress={clearFilters} size="sm" variant="ghost">
            <SlidersHorizontal aria-hidden="true" /> Reset
          </Button>
        </div>
      </div>
      <section aria-labelledby="conversations-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="conversations-heading" className="flex items-center gap-2 text-sm font-semibold">
            Conversations <Badge className="tabular-nums">{filteredMessages.length}</Badge>
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums">
            <p aria-live="polite" aria-atomic="true" className="text-muted-foreground">
              <span className="sr-only">{filteredMessages.length} conversations. </span>
              {unreadCount} unread {unreadCount === 1 ? 'message' : 'messages'}
            </p>
            {fetchErrors > 0 ? (
              <p role="status" className="text-destructive">{fetchErrors} {fetchErrors === 1 ? 'account needs attention' : 'accounts need attention'}</p>
            ) : null}
          </div>
        </div>
        {filteredMessages.length === 0 ? (
          <MessageEmptyState hasAccounts={accountIds.length > 0} hasMessages={accountMessages.length > 0} search={normalizedSearch} unreadOnly={unreadOnly} sync={filteredSync} onReset={clearFilters} />
        ) : (
          <>
            <MessageList messages={rows} />
            <Pagination label="Private messages" page={currentPage} onPageChange={setPage} pageSize={PAGE_SIZE} total={filteredMessages.length} />
          </>
        )}
      </section>
      <MessageSync sync={filteredSync} />
    </>
  );
}
