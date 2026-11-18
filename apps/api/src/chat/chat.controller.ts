import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {
  ChatConversationStateRequest,
  ChatOpenConversationRequest,
  ChatPushTokenRequest,
  ChatReportRequest,
  ChatSendMessageRequest,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { ChatService } from './chat.service';
import { ChatPushService } from './chat-push.service';
import { CHAT_THROTTLE } from './chat-throttle';

/**
 * User-to-user chat REST (app-only feature). All routes require a
 * Bearer access token; every handler scopes to `req.user.userId`.
 * Response bodies are the contract objects directly, like the
 * rest of this API.
 *
 * Rate limiting (deep-analysis fix pass): ThrottlerGuard runs
 * AFTER AccessTokenGuard so the chat-user bucket keys on the
 * authenticated user id (see chat-throttle.ts for the limits).
 * The socket send path is limited in the gateway instead, and
 * the service enforces the caps both transports share.
 */
@Controller()
@UseGuards(AccessTokenGuard, ThrottlerGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly push: ChatPushService,
  ) {}

  /** GET /chat/conversations?cursor&limit — the inbox, paginated (incoming requests are counted, not listed). */
  @Get('chat/conversations')
  listConversations(
    @Req() req: { user: TokenPayload },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listConversations(req.user.userId, cursor, limit);
  }

  /** GET /chat/conversations/archived?cursor&limit — the caller's archived conversations. */
  @Get('chat/conversations/archived')
  listArchived(
    @Req() req: { user: TokenPayload },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listArchived(req.user.userId, cursor, limit);
  }

  /** GET /chat/requests?cursor&limit — pending incoming message requests, paginated. */
  @Get('chat/requests')
  listRequests(
    @Req() req: { user: TokenPayload },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listRequests(req.user.userId, cursor, limit);
  }

  /** GET /chat/counts — badge counts only (requestCount + totalUnread), no list payload. */
  @Get('chat/counts')
  counts(@Req() req: { user: TokenPayload }) {
    return this.chat.counts(req.user.userId);
  }

  /** GET /chat/conversations/:id/meta — participant header meta; answers for blocked conversations too (no messages). */
  @Get('chat/conversations/:id/meta')
  conversationMeta(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
  ) {
    return this.chat.conversationMeta(req.user.userId, id);
  }

  /** POST /chat/conversations — get-or-create the 1:1 conversation with a user. */
  @Post('chat/conversations')
  @Throttle(CHAT_THROTTLE.open)
  openConversation(
    @Req() req: { user: TokenPayload },
    @Body() body: ChatOpenConversationRequest,
  ) {
    return this.chat.openConversation(req.user.userId, body?.userId);
  }

  /** GET /chat/conversations/:id/messages?before&limit — newest page, ascending inside the page. */
  @Get('chat/conversations/:id/messages')
  listMessages(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listMessages(req.user.userId, id, before, limit);
  }

  /** POST /chat/conversations/:id/messages — REST send (the socket 'chat:send' is the realtime twin). */
  @Post('chat/conversations/:id/messages')
  @Throttle(CHAT_THROTTLE.send)
  sendMessage(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Body() body: ChatSendMessageRequest,
  ) {
    const safeBody = body ?? ({} as ChatSendMessageRequest);
    return this.chat.sendMessage(
      req.user.userId,
      id,
      safeBody,
      safeBody.clientId,
    );
  }

  /** POST /chat/conversations/:id/read — mark the conversation read (receipt only in active conversations). */
  @Post('chat/conversations/:id/read')
  markRead(@Req() req: { user: TokenPayload }, @Param('id') id: string) {
    return this.chat.markRead(req.user.userId, id);
  }

  /** POST /chat/conversations/:id/accept — accept a message request. */
  @Post('chat/conversations/:id/accept')
  acceptRequest(@Req() req: { user: TokenPayload }, @Param('id') id: string) {
    return this.chat.acceptRequest(req.user.userId, id);
  }

  /** POST /chat/conversations/:id/decline — decline a request (silent: the sender is never notified). */
  @Post('chat/conversations/:id/decline')
  declineRequest(@Req() req: { user: TokenPayload }, @Param('id') id: string) {
    return this.chat.declineRequest(req.user.userId, id);
  }

  /** POST /chat/conversations/:id/state — set the caller's mute/archive flags. */
  @Post('chat/conversations/:id/state')
  setConversationState(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Body() body: ChatConversationStateRequest,
  ) {
    return this.chat.setConversationState(req.user.userId, id, body ?? {});
  }

  /** POST /chat/conversations/:id/delete-for-me — hide the conversation and its history for the caller only. */
  @Post('chat/conversations/:id/delete-for-me')
  clearConversation(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
  ) {
    return this.chat.clearConversation(req.user.userId, id);
  }

  /** POST /chat/users/:userId/block — block a user for DMs and close the pair's conversation. */
  @Post('chat/users/:userId/block')
  blockUser(@Req() req: { user: TokenPayload }, @Param('userId') userId: string) {
    return this.chat.blockUser(req.user.userId, userId);
  }

  /** POST /chat/users/:userId/unblock — remove my block (see ChatService.unblockUser for the reopen semantics). */
  @Post('chat/users/:userId/unblock')
  unblockUser(
    @Req() req: { user: TokenPayload },
    @Param('userId') userId: string,
  ) {
    return this.chat.unblockUser(req.user.userId, userId);
  }

  /** GET /chat/users/blocked — the users I have blocked (settings list). */
  @Get('chat/users/blocked')
  listBlockedUsers(@Req() req: { user: TokenPayload }) {
    return this.chat.listBlockedUsers(req.user.userId);
  }

  /** POST /chat/reports — file a report (user, optionally anchored to a message with a frozen snapshot). */
  @Post('chat/reports')
  reportUser(
    @Req() req: { user: TokenPayload },
    @Body() body: ChatReportRequest,
  ) {
    return this.chat.reportUser(req.user.userId, body ?? ({} as ChatReportRequest));
  }

  /** GET /chat/reports — operator queue (ADMIN_USER_IDS env; empty list = nobody). */
  @Get('chat/reports')
  listReports(@Req() req: { user: TokenPayload }) {
    return this.chat.listReports(req.user.userId);
  }

  /** POST /chat/push-token — register this device's Expo push token for chat pushes. */
  @Post('chat/push-token')
  async registerPushToken(
    @Req() req: { user: TokenPayload },
    @Body() body: ChatPushTokenRequest,
  ) {
    await this.push.registerToken(req.user.userId, body?.token);
    return { registered: true };
  }

  /** DELETE /chat/push-token — unregister this device's token (logout). */
  @Delete('chat/push-token')
  async unregisterPushToken(
    @Req() req: { user: TokenPayload },
    @Body() body: ChatPushTokenRequest,
  ) {
    await this.push.unregisterToken(req.user.userId, body?.token);
    return { registered: false };
  }

  /** GET /chat/people — New Chat sections: quiz-room people + suggested. */
  @Get('chat/people')
  people(@Req() req: { user: TokenPayload }) {
    return this.chat.people(req.user.userId);
  }

  /** GET /chat/people/search?q= — live username search for New Chat. */
  @Get('chat/people/search')
  @Throttle(CHAT_THROTTLE.search)
  searchPeople(@Req() req: { user: TokenPayload }, @Query('q') q?: string) {
    return this.chat.searchPeople(req.user.userId, q);
  }
}
