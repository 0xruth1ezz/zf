import { useMemo, useSyncExternalStore } from 'react';
import type { DashboardPayload } from '../types';

export interface UrlFilters {
  account: string;
  activitySearch: string;
  includeDrawn: boolean;
  includeUnknown: boolean;
  sort: 'engagedAt' | 'drawAt';
  direction: 'ascending' | 'descending';
  activityTab: 'lotteries' | 'sign-ins';
  lotteryPage: number;
  signInPage: number;
  messagesSearch: string;
  unreadOnly: boolean;
  messagesPage: number;
}

export type UpdateFilters = (changes: Partial<UrlFilters>, options?: { replace?: boolean }) => void;

export interface FilteredPageProps {
  data: DashboardPayload;
  filters: UrlFilters;
  setFilters: UpdateFilters;
  accountIds: string[];
}

export const FILTER_DEFAULTS: Readonly<UrlFilters> = Object.freeze({
  account: 'all',
  activitySearch: '',
  includeDrawn: false,
  includeUnknown: false,
  sort: 'engagedAt',
  direction: 'descending',
  activityTab: 'lotteries',
  lotteryPage: 1,
  signInPage: 1,
  messagesSearch: '',
  unreadOnly: false,
  messagesPage: 1,
});

const filterKeys = Object.keys(FILTER_DEFAULTS) as (keyof UrlFilters)[];
const lotteryFilterKeys = ['includeDrawn', 'includeUnknown', 'sort', 'direction'] as const;
const changeEvent = 'zf:filters-changed';

function readFilters(search: string): UrlFilters {
  const params = new URLSearchParams(search);
  function readPage(key: 'lotteryPage' | 'signInPage' | 'messagesPage') {
    const value = params.get(key) || '';
    const page = Number(value);
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(page) ? page : FILTER_DEFAULTS[key];
  }
  function readChoice<T extends string>(key: keyof UrlFilters, allowed: readonly T[], fallback: T): T {
    const value = params.get(key);
    return allowed.find((choice) => choice === value) ?? fallback;
  }
  return {
    account: params.get('account') || FILTER_DEFAULTS.account,
    activitySearch: params.get('activitySearch') || FILTER_DEFAULTS.activitySearch,
    includeDrawn: params.get('includeDrawn') === '1',
    includeUnknown: params.get('includeUnknown') === '1',
    sort: readChoice('sort', ['engagedAt', 'drawAt'], FILTER_DEFAULTS.sort),
    direction: readChoice('direction', ['ascending', 'descending'], FILTER_DEFAULTS.direction),
    activityTab: readChoice('activityTab', ['lotteries', 'sign-ins'], FILTER_DEFAULTS.activityTab),
    lotteryPage: readPage('lotteryPage'),
    signInPage: readPage('signInPage'),
    messagesSearch: params.get('messagesSearch') || FILTER_DEFAULTS.messagesSearch,
    unreadOnly: params.get('unreadOnly') === '1',
    messagesPage: readPage('messagesPage'),
  };
}

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback);
  window.addEventListener('hashchange', callback);
  window.addEventListener(changeEvent, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener('hashchange', callback);
    window.removeEventListener(changeEvent, callback);
  };
}

const updateFilters: UpdateFilters = (changes, { replace = false } = {}) => {
  // Read the latest URL so multiple controls cannot overwrite one another's changes.
  const url = new URL(window.location.href);
  const current = readFilters(url.search);
  const next = { ...current, ...changes };
  if (next.account !== current.account) {
    next.lotteryPage = next.signInPage = next.messagesPage = 1;
  }
  if (next.activitySearch !== current.activitySearch) next.lotteryPage = next.signInPage = 1;
  if (lotteryFilterKeys.some((key) => next[key] !== current[key])) {
    next.lotteryPage = 1;
  }
  if (next.messagesSearch !== current.messagesSearch || next.unreadOnly !== current.unreadOnly) {
    next.messagesPage = 1;
  }
  for (const key of filterKeys) {
    const fallback = FILTER_DEFAULTS[key];
    if (next[key] === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, typeof fallback === 'boolean' ? '1' : String(next[key]));
  }
  if (url.href === window.location.href) return;
  window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
  window.dispatchEvent(new Event(changeEvent));
};

export function useUrlFilters(): [UrlFilters, UpdateFilters] {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => '');
  const filters = useMemo(() => readFilters(search), [search]);
  return [filters, updateFilters];
}
