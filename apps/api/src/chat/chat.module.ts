import { Module, type DynamicModule } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { User, UserSchema } from '../auth/user.schema';
import { Follow, FollowSchema } from '../social/follow.schema';
import { UserRank, UserRankSchema } from '../quiz/user-rank.schema';
import { RankHistory, RankHistorySchema } from '../quiz/rank-history.schema';
import { ThemeCache, ThemeCacheSchema } from '../themes/theme-cache.schema';
import { ChatBroadcaster } from './chat-broadcaster';
import { ChatBlock, ChatBlockSchema } from './chat-block.schema';
import {
  ChatConversation,
  ChatConversationSchema,
} from './chat-conversation.schema';
import { ChatController } from './chat.controller';
import { ChatDecline, ChatDeclineSchema } from './chat-decline.schema';
import { ChatGateway } from './chat.gateway';
import {
  ChatMessage,
  ChatMessageSchema,
} from './chat-message.schema';
import { ChatMetrics } from './chat-metrics';
import { ChatPresence } from './chat-presence';
import {
  ChatPushToken,
  ChatPushTokenSchema,
} from './chat-push-token.schema';
import { ChatPushService } from './chat-push.service';
import { ChatReport, ChatReportSchema } from './chat-report.schema';
import { ChatService } from './chat.service';
import { CHAT_THROTTLER_OPTIONS } from './chat-throttle';

/**
 * User-to-user chat (app-only feature). Read models borrowed from
 * the shared DB (users, follows, userranks, rankhistories,
 * themecaches) are re-registered here like every other module
 * does; the chat collections are new and additive (conversations,
 * messages, blocks, declines, push tokens, reports).
 *
 * The throttler is scoped exactly like AuthModule's: the module
 * imports its own bucket set (chat-throttle.ts) and the guard
 * rides only on the chat controller.
 */
@Module({})
export class ChatModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: ChatModule,
      imports: [
        ThrottlerModule.forRoot(CHAT_THROTTLER_OPTIONS),
        ...(withDatabase
          ? [
              MongooseModule.forFeature([
                { name: User.name, schema: UserSchema },
                { name: Follow.name, schema: FollowSchema },
                { name: UserRank.name, schema: UserRankSchema },
                { name: RankHistory.name, schema: RankHistorySchema },
                { name: ThemeCache.name, schema: ThemeCacheSchema },
                { name: ChatConversation.name, schema: ChatConversationSchema },
                { name: ChatMessage.name, schema: ChatMessageSchema },
                { name: ChatBlock.name, schema: ChatBlockSchema },
                { name: ChatDecline.name, schema: ChatDeclineSchema },
                { name: ChatPushToken.name, schema: ChatPushTokenSchema },
                { name: ChatReport.name, schema: ChatReportSchema },
              ]),
            ]
          : []),
      ],
      controllers: [ChatController],
      providers: [
        ChatService,
        ChatGateway,
        ChatBroadcaster,
        ChatPresence,
        ChatPushService,
        ChatMetrics,
        AuthService,
        AccessTokenGuard,
      ],
    };
  }
}
