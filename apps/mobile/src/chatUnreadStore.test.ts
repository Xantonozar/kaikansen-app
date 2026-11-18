import { describe, expect, it } from '@jest/globals';
import {
  getChatUnread,
  resetChatUnread,
  setChatUnread,
} from './chatUnreadStore';

/**
 * Badge store session reset (deep-analysis fix pass): logout /
 * expiry / account switch must zero the badge so one account's
 * unread never shows in another's session.
 */
describe('chatUnreadStore reset', () => {
  it('setChatUnread clamps and resetChatUnread zeroes', () => {
    setChatUnread(7);
    expect(getChatUnread()).toBe(7);
    setChatUnread(-3);
    expect(getChatUnread()).toBe(0);
    setChatUnread(12);
    resetChatUnread();
    expect(getChatUnread()).toBe(0);
  });
});
