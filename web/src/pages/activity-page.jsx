import { useMemo, useState } from 'react';
import { ExternalLink, Filter, SlidersHorizontal } from 'lucide-react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/field';
import { Select, SelectItem } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import {
  Table,
  TableCell,
  TableColumn,
  TableHeaderRow,
  TableRow,
  TableRows,
} from '../components/ui/table';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import {
  chinaDateKey,
  chinaMinuteKey,
  formatDateTime,
  formatDrawTime,
  humanizeStatus,
  statusVariant,
} from '../data';

const PAGE_SIZE = 20;
const sortOptions = [
  { id: 'engaged_desc', label: 'Last engaged · newest' },
  { id: 'engaged_asc', label: 'Last engaged · oldest' },
  { id: 'draw_asc', label: 'Draw time · soonest' },
  { id: 'draw_desc', label: 'Draw time · latest' },
];

function compareOptional(left, right, ascending) {
  if (left && right) return ascending ? left.localeCompare(right) : right.localeCompare(left);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function EmptyState({ title, description, onReset }) {
  return (
    <div className="grid min-h-52 place-items-center rounded-lg border border-dashed border-border bg-muted/25 px-6 py-10 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Filter aria-hidden="true" className="size-4" />
        </div>
        <h3 className="mt-3 text-sm font-semibold">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
        {onReset ? <Button className="mt-4" onPress={onReset} size="sm" variant="outline">Clear filters</Button> : null}
      </div>
    </div>
  );
}

function Summary({ accounts, records, signIns, generatedAt }) {
  const enabled = accounts.filter((account) => account.enabled).length;
  const today = chinaDateKey();
  const signedToday = signIns.filter((item) => item.signInDate === today).length;
  const now = chinaMinuteKey();
  const activeDraws = records.filter((record) => {
    const draw = formatDrawTime(record.drawAt);
    return draw !== 'Unknown' && draw > now;
  }).length;
  const items = [
    ['Enabled accounts', enabled],
    ['Active draws', activeDraws],
    ['Signed in today', signedToday],
    ['Total engagements', records.length],
  ];

  return (
    <dl className="mb-6 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card text-card-foreground lg:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="border-b border-border px-4 py-3.5 odd:border-r [&:nth-child(n+3)]:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0">
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
        </div>
      ))}
      <span className="sr-only">Data generated {formatDateTime(generatedAt)}</span>
    </dl>
  );
}

function LotteryTable({ records, page, onPageChange }) {
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  if (records.length === 0) {
    return <EmptyState title="No matching lottery threads" description="Adjust the account, search, or draw-state filters to broaden the activity shown here." />;
  }

  return (
    <>
      <div aria-label="Lottery threads table" className="overflow-x-auto rounded-lg border border-border bg-card" role="region" tabIndex={0}>
        <Table aria-label="Lottery threads" className="min-w-[920px]">
          <TableHeaderRow>
            <TableColumn className="w-12 text-center">#</TableColumn>
            <TableColumn className="w-36">Account</TableColumn>
            <TableColumn isRowHeader>Thread</TableColumn>
            <TableColumn className="w-44">Draw time</TableColumn>
            <TableColumn className="w-32">Daily count</TableColumn>
            <TableColumn className="hidden w-48 xl:table-cell">Last engaged</TableColumn>
            <TableColumn className="hidden w-32 2xl:table-cell">Post ID</TableColumn>
          </TableHeaderRow>
          <TableRows items={rows}>
            {(record) => (
              <TableRow id={`${record.accountId}:${record.postId}`}>
                <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                  {currentPage * PAGE_SIZE + rows.indexOf(record) + 1}
                </TableCell>
                <TableCell><code className="code-label">{record.accountId}</code></TableCell>
                <TableCell className="min-w-72 max-w-xl text-left">
                  <a className="inline-flex items-start gap-1.5 font-medium text-foreground underline decoration-border underline-offset-4 hover:text-primary hover:decoration-primary" href={record.url} rel="noreferrer" target="_blank">
                    <span className="whitespace-normal text-pretty">{record.title}</span>
                    <ExternalLink aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  </a>
                </TableCell>
                <TableCell>
                  {record.drawAt ? <time className="tabular-nums" dateTime={record.drawAt}>{formatDrawTime(record.drawAt)}</time> : <Badge>Unknown</Badge>}
                </TableCell>
                <TableCell>
                  {record.lastEngagedDate && record.dailyEngagementCount > 0 ? (
                    <span className="grid gap-0.5">
                      <strong className="font-semibold tabular-nums">{record.dailyEngagementCount}</strong>
                      <span className="text-xs tabular-nums text-muted-foreground">{record.lastEngagedDate}</span>
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="hidden text-left text-xs tabular-nums text-muted-foreground xl:table-cell">
                  <time dateTime={record.engagedAt}>{formatDateTime(record.engagedAt)}</time>
                </TableCell>
                <TableCell className="hidden text-left 2xl:table-cell"><code className="code-label">{record.postId}</code></TableCell>
              </TableRow>
            )}
          </TableRows>
        </Table>
      </div>
      <Pagination label="Lottery threads" onPageChange={onPageChange} page={currentPage} pageSize={PAGE_SIZE} total={records.length} />
    </>
  );
}

function SignInTable({ signIns, page, onPageChange }) {
  const pageCount = Math.max(1, Math.ceil(signIns.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = signIns.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  if (signIns.length === 0) {
    return <EmptyState title="No matching sign-ins" description="No recorded sign-ins match the current account and search filters." />;
  }

  return (
    <>
      <div aria-label="Daily sign-ins table" className="overflow-x-auto rounded-lg border border-border bg-card" role="region" tabIndex={0}>
        <Table aria-label="Daily sign-ins" className="min-w-[760px]">
          <TableHeaderRow>
            <TableColumn className="w-12 text-center">#</TableColumn>
            <TableColumn className="w-40" isRowHeader>Account</TableColumn>
            <TableColumn className="w-36">Date</TableColumn>
            <TableColumn className="w-52">Signed at</TableColumn>
            <TableColumn className="w-36">Status</TableColumn>
            <TableColumn>Message</TableColumn>
          </TableHeaderRow>
          <TableRows items={rows}>
            {(record) => (
              <TableRow id={`${record.accountId}:${record.signInDate}`}>
                <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                  {currentPage * PAGE_SIZE + rows.indexOf(record) + 1}
                </TableCell>
                <TableCell className="text-left"><code className="code-label">{record.accountId}</code></TableCell>
                <TableCell className="text-left"><code className="code-label">{record.signInDate}</code></TableCell>
                <TableCell className="text-left tabular-nums"><time dateTime={record.signedAt}>{formatDateTime(record.signedAt)}</time></TableCell>
                <TableCell className="text-left"><Badge variant={statusVariant(record.status)}>{humanizeStatus(record.status)}</Badge></TableCell>
                <TableCell className="min-w-56 text-left whitespace-normal text-muted-foreground">{record.message || '—'}</TableCell>
              </TableRow>
            )}
          </TableRows>
        </Table>
      </div>
      <Pagination label="Daily sign-ins" onPageChange={onPageChange} page={currentPage} pageSize={PAGE_SIZE} total={signIns.length} />
    </>
  );
}

export function ActivityPage({ data }) {
  const [account, setAccount] = useState('all');
  const [sort, setSort] = useState('engaged_desc');
  const [search, setSearch] = useState('');
  const [includeDrawn, setIncludeDrawn] = useState(false);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [lotteryPage, setLotteryPage] = useState(0);
  const [signInPage, setSignInPage] = useState(0);

  const accountIds = useMemo(() => {
    const ids = new Set();
    for (const item of data.accounts) ids.add(item.id);
    for (const item of data.records) ids.add(item.accountId);
    for (const item of data.signIns) ids.add(item.accountId);
    return Array.from(ids).sort();
  }, [data]);

  const filteredRecords = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const now = chinaMinuteKey();
    return data.records
      .filter((record) => {
        if (account !== 'all' && record.accountId !== account) return false;
        if (normalizedSearch && !`${record.title} ${record.postId} ${record.accountId}`.toLowerCase().includes(normalizedSearch)) return false;
        const draw = formatDrawTime(record.drawAt);
        if (draw === 'Unknown') return includeUnknown;
        return includeDrawn || draw > now;
      })
      .sort((left, right) => {
        const byValue = sort.startsWith('draw')
          ? compareOptional(formatDrawTime(left.drawAt) === 'Unknown' ? '' : formatDrawTime(left.drawAt), formatDrawTime(right.drawAt) === 'Unknown' ? '' : formatDrawTime(right.drawAt), sort === 'draw_asc')
          : compareOptional(left.engagedAt, right.engagedAt, sort === 'engaged_asc');
        return byValue || left.accountId.localeCompare(right.accountId) || left.postId.localeCompare(right.postId);
      });
  }, [account, data.records, includeDrawn, includeUnknown, search, sort]);

  const filteredSignIns = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return data.signIns.filter((record) => (
      (account === 'all' || record.accountId === account)
      && (!normalizedSearch || `${record.accountId} ${record.status} ${record.message}`.toLowerCase().includes(normalizedSearch))
    ));
  }, [account, data.signIns, search]);

  function resetPages() {
    setLotteryPage(0);
    setSignInPage(0);
  }

  function clearFilters() {
    setAccount('all');
    setSort('engaged_desc');
    setSearch('');
    setIncludeDrawn(false);
    setIncludeUnknown(false);
    resetPages();
  }

  return (
    <>
      <PageHeader title="Activity" description="Review lottery engagement and daily sign-in outcomes across every crawler account." />
      <Summary accounts={data.accounts} generatedAt={data.generatedAt} records={data.records} signIns={data.signIns} />

      <div className="mb-6 rounded-lg border border-border bg-card p-3 shadow-xs">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_200px_220px]">
          <Field
            aria-label="Search activity"
            label="Search"
            onChange={(value) => { setSearch(value); resetPages(); }}
            placeholder="Thread, post ID, status…"
            value={search}
          />
          <Select label="Account" onSelectionChange={(key) => { setAccount(String(key)); resetPages(); }} selectedKey={account}>
            <SelectItem id="all">All accounts</SelectItem>
            {accountIds.map((id) => <SelectItem key={id} id={id}>{id}</SelectItem>)}
          </Select>
          <Select label="Sort lotteries" onSelectionChange={(key) => { setSort(String(key)); setLotteryPage(0); }} selectedKey={sort}>
            {sortOptions.map((item) => <SelectItem key={item.id} id={item.id}>{item.label}</SelectItem>)}
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
          <div className="mr-auto flex flex-wrap items-center gap-x-5 gap-y-1">
            <Switch isSelected={includeDrawn} onChange={(value) => { setIncludeDrawn(value); setLotteryPage(0); }}>Include drawn</Switch>
            <Switch isSelected={includeUnknown} onChange={(value) => { setIncludeUnknown(value); setLotteryPage(0); }}>Unknown draw times</Switch>
          </div>
          <Button onPress={clearFilters} size="sm" variant="ghost">
            <SlidersHorizontal aria-hidden="true" /> Reset
          </Button>
        </div>
      </div>

      <Tabs defaultSelectedKey="lotteries">
        <TabList aria-label="Activity type" className="mb-4 flex w-fit gap-1 rounded-lg bg-muted p-1">
          <Tab className="tab-trigger" id="lotteries">Lottery threads <span>{filteredRecords.length}</span></Tab>
          <Tab className="tab-trigger" id="sign-ins">Daily sign-ins <span>{filteredSignIns.length}</span></Tab>
        </TabList>
        <TabPanel className="outline-none" id="lotteries">
          {filteredRecords.length === 0 ? (
            <EmptyState
              description="Adjust the account, search, or draw-state filters to broaden the activity shown here."
              onReset={clearFilters}
              title="No matching lottery threads"
            />
          ) : <LotteryTable onPageChange={setLotteryPage} page={lotteryPage} records={filteredRecords} />}
        </TabPanel>
        <TabPanel className="outline-none" id="sign-ins">
          {filteredSignIns.length === 0 ? (
            <EmptyState
              description="Choose another account or clear the search to review more sign-in history."
              onReset={clearFilters}
              title="No matching sign-ins"
            />
          ) : <SignInTable onPageChange={setSignInPage} page={signInPage} signIns={filteredSignIns} />}
        </TabPanel>
      </Tabs>
    </>
  );
}
