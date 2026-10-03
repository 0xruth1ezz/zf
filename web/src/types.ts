export type Route = 'activity' | 'messages' | 'accounts';

export interface AccountConfig {
  id: string;
  phone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LotteryRecord {
  accountId: string;
  postId: string;
  title: string;
  url: string;
  drawAt: string;
  lastEngagedDate: string;
  dailyEngagementCount: number;
  engagedAt: string;
}

export interface SignInRecord {
  accountId: string;
  signInDate: string;
  signedAt: string;
  status: string;
  message: string;
}

export interface PrivateMessage {
  accountId: string;
  messageId: string;
  sender: string;
  preview: string;
  url: string;
  sentAt: string;
  unreadCount: number;
}

export interface MessageSyncStatus {
  accountId: string;
  fetchedAt: string;
  error: string;
}

export interface DashboardPayload {
  accounts: AccountConfig[];
  records: LotteryRecord[];
  signIns: SignInRecord[];
  messages: PrivateMessage[];
  messageSync: MessageSyncStatus[];
  generatedAt: string;
  isSnapshot: boolean;
}

export interface AccountFormValues {
  id: string;
  phone: string;
  password: string;
  enabled?: '1';
}

export interface LoginValues {
  username: string;
  password: string;
}
