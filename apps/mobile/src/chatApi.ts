import type {
  ChatBlockedListResponse,
  ChatConversationListResponse,
  ChatConversationMetaResponse,
  ChatConversationStateRequest,
  ChatConversationSummary,
  ChatCountsResponse,
  ChatMessage,
  ChatMessageListResponse,
  ChatOpenConversationResponse,
  ChatPeopleResponse,
  ChatPeopleSearchResponse,
  ChatReportRequest,
  ChatRequestListResponse,
  ChatSendMessageRequest,
} from '@kaikansen/contracts';
import { apiJson, fixtureMode } from './api';
import { getAccessToken } from './session';
import { ladderForRp } from './rankUtil';

/**
 * Chat API client — the socialApi.ts pattern (typed REST over
 * apiJson; fixture mode resolves inert empties; every call needs
 * a signed-in session because every chat route sits behind the
 * API's AccessTokenGuard).
 */

const SIGN_IN_REQUIRED = 'Sign in to use chat.';

function guard(): void {
  if (fixtureMode) return;
  if (!getAccessToken()) throw new Error(SIGN_IN_REQUIRED);
}

const EMPTY_CONVERSATIONS: ChatConversationListResponse = {
  conversations: [],
  requestCount: 0,
  totalUnread: 0,
  archivedCount: 0,
  nextCursor: null,
};

const EMPTY_REQUESTS: ChatRequestListResponse = {
  requests: [],
  nextCursor: null,
};

const EMPTY_PEOPLE: ChatPeopleResponse = { quizRoomPeople: [], suggested: [] };

function emptyThread(): ChatMessageListResponse {
  return {
    messages: [],
    hasMore: false,
    status: 'active',
    requestedBy: null,
    other: {
      id: 'fixture',
      username: 'someone',
      displayName: 'Someone',
      avatarUrl: null,
      rp: 0,
      ladder: ladderForRp(0),
      online: false,
      lastActiveAt: null,
    },
  };
}

/** One page of a cursor-paginated chat list (inbox / requests / archived). */
export interface ChatListPage {
  cursor?: string;
  limit?: number;
}

function pageQuery(page?: ChatListPage): string {
  const params = new URLSearchParams();
  if (page?.cursor) params.set('cursor', page.cursor);
  if (page?.limit) params.set('limit', String(page.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchConversations(
  page?: ChatListPage,
): Promise<ChatConversationListResponse> {
  guard();
  if (fixtureMode) return EMPTY_CONVERSATIONS;
  return apiJson<ChatConversationListResponse>(
    `/chat/conversations${pageQuery(page)}`,
  );
}

export async function fetchArchivedConversations(
  page?: ChatListPage,
): Promise<ChatConversationListResponse> {
  guard();
  if (fixtureMode) return EMPTY_CONVERSATIONS;
  return apiJson<ChatConversationListResponse>(
    `/chat/conversations/archived${pageQuery(page)}`,
  );
}

export async function fetchChatRequests(
  page?: ChatListPage,
): Promise<ChatRequestListResponse> {
  guard();
  if (fixtureMode) return EMPTY_REQUESTS;
  return apiJson<ChatRequestListResponse>(`/chat/requests${pageQuery(page)}`);
}

/** Badge counts only — the lightweight alternative to refetching the whole inbox list. */
export async function fetchChatCounts(): Promise<ChatCountsResponse> {
  guard();
  if (fixtureMode) return { requestCount: 0, totalUnread: 0 };
  return apiJson<ChatCountsResponse>('/chat/counts');
}

/**
 * Participant meta for one conversation. Unlike the messages
 * endpoint this answers for BLOCKED conversations too, so the
 * thread screen can render its closed state.
 */
export async function fetchChatMeta(
  conversationId: string,
): Promise<ChatConversationMetaResponse> {
  guard();
  if (fixtureMode) {
    return {
      id: conversationId,
      status: 'active',
      requestedBy: null,
      other: emptyThread().other,
    };
  }
  return apiJson<ChatConversationMetaResponse>(
    `/chat/conversations/${conversationId}/meta`,
  );
}

/** Opens (or creates) the 1:1 conversation with a user. */
export async function openConversation(
  userId: string,
): Promise<ChatOpenConversationResponse> {
  guard();
  if (fixtureMode) {
    return {
      conversation: {
        id: 'fixture',
        other: emptyThread().other,
        status: 'active',
        requestedBy: null,
        lastMessage: null,
        unreadCount: 0,
        muted: false,
        archived: false,
        updatedAt: new Date(0).toISOString(),
      },
      created: false,
    };
  }
  return apiJson<ChatOpenConversationResponse>('/chat/conversations', {
    method: 'POST',
    body: { userId },
  });
}

/** Sets the caller's mute/archive flags on a conversation; resolves with the fresh summary. */
export async function setConversationState(
  conversationId: string,
  state: ChatConversationStateRequest,
): Promise<ChatConversationSummary> {
  guard();
  if (fixtureMode) throw new Error(SIGN_IN_REQUIRED);
  return apiJson<ChatConversationSummary>(
    `/chat/conversations/${conversationId}/state`,
    { method: 'POST', body: state },
  );
}

/** Delete-for-me: hides the conversation + its history for the caller only. */
export async function clearConversation(
  conversationId: string,
): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/conversations/${conversationId}/delete-for-me`, {
    method: 'POST',
    body: {},
  });
}

export async function fetchChatMessages(
  conversationId: string,
  before?: string,
): Promise<ChatMessageListResponse> {
  guard();
  if (fixtureMode) return emptyThread();
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  return apiJson<ChatMessageListResponse>(
    `/chat/conversations/${conversationId}/messages${query}`,
  );
}

/** REST send (the socket path is primary; this is its fallback). */
export async function sendChatMessage(
  conversationId: string,
  body: ChatSendMessageRequest,
): Promise<ChatMessage> {
  guard();
  if (fixtureMode) throw new Error(SIGN_IN_REQUIRED);
  return apiJson<ChatMessage>(`/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body,
  });
}

export async function markChatRead(conversationId: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/conversations/${conversationId}/read`, {
    method: 'POST',
    body: {},
  });
}

export async function acceptChatRequest(conversationId: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/conversations/${conversationId}/accept`, {
    method: 'POST',
    body: {},
  });
}

export async function declineChatRequest(conversationId: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/conversations/${conversationId}/decline`, {
    method: 'POST',
    body: {},
  });
}

export async function blockChatUser(userId: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/users/${userId}/block`, { method: 'POST', body: {} });
}

export async function unblockChatUser(userId: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson(`/chat/users/${userId}/unblock`, { method: 'POST', body: {} });
}

/** The users I have blocked (blocked-users settings screen). */
export async function fetchBlockedUsers(): Promise<ChatBlockedListResponse> {
  guard();
  if (fixtureMode) return { users: [] };
  return apiJson<ChatBlockedListResponse>('/chat/users/blocked');
}

/** Files a report (user report, optionally anchored to one message). */
export async function reportChatUser(body: ChatReportRequest): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson('/chat/reports', { method: 'POST', body });
}

/** Registers this device's Expo push token for chat pushes (sign-in). */
export async function registerPushToken(token: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson('/chat/push-token', { method: 'POST', body: { token } });
}

/** Unregisters this device's Expo push token (logout). */
export async function unregisterPushToken(token: string): Promise<void> {
  guard();
  if (fixtureMode) return;
  await apiJson('/chat/push-token', { method: 'DELETE', body: { token } });
}

export async function fetchChatPeople(): Promise<ChatPeopleResponse> {
  guard();
  if (fixtureMode) return EMPTY_PEOPLE;
  return apiJson<ChatPeopleResponse>('/chat/people');
}

export async function searchChatPeople(
  query: string,
): Promise<ChatPeopleSearchResponse> {
  guard();
  if (fixtureMode) return { query, users: [] };
  return apiJson<ChatPeopleSearchResponse>(
    `/chat/people/search?q=${encodeURIComponent(query)}`,
  );
}
