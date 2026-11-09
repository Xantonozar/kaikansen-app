import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Transactional email via Brevo — the API's first email capability
 * (the web has none anywhere). Today it sends exactly one thing:
 * password-reset codes.
 *
 * Configured ONLY through the environment: `BREVO_API_KEY` and
 * `MAIL_FROM` (see .env.example). The sender must be a verified
 * Brevo sender, chosen at deploy time — no sender address is
 * hardcoded here.
 *
 * FAIL CLOSED: when either value is unset, or Brevo rejects the
 * send, the method returns false and logs the skip/failure. It
 * never throws (callers still answer their generic responses) and
 * it NEVER logs the code or the API key.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(@Optional() private readonly config?: ConfigService) {}

  private setting(name: string): string {
    return (this.config?.get<string>(name) ?? '').trim();
  }

  /** True when both Brevo env values are present. */
  get configured(): boolean {
    return Boolean(this.setting('BREVO_API_KEY') && this.setting('MAIL_FROM'));
  }

  /**
   * Sends the password-reset code email. Returns true only when
   * Brevo accepted the message.
   */
  async sendPasswordResetCode(email: string, code: string): Promise<boolean> {
    const apiKey = this.setting('BREVO_API_KEY');
    const from = this.setting('MAIL_FROM');
    if (!apiKey || !from) {
      this.logger.warn(
        'Password reset email skipped — BREVO_API_KEY / MAIL_FROM not configured',
      );
      return false;
    }
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: from, name: 'Kaikansen' },
          to: [{ email }],
          subject: 'Your Kaikansen password reset code',
          textContent: [
            `Your Kaikansen password reset code is ${code}.`,
            '',
            'It expires in 15 minutes. Enter it in the app to choose a new password.',
            '',
            "If you didn't request a password reset, you can ignore this email — your password stays unchanged.",
          ].join('\n'),
        }),
      });
      if (!res.ok) {
        this.logger.warn(
          `Password reset email failed — Brevo answered ${res.status}`,
        );
        return false;
      }
      return true;
    } catch {
      this.logger.warn('Password reset email failed — Brevo unreachable');
      return false;
    }
  }
}
