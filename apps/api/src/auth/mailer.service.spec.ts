import type { ConfigService } from '@nestjs/config';
import { MailerService } from './mailer.service';

/**
 * MailerService unit tests. `fetch` is stubbed — no real email is
 * ever sent, and the Brevo key below is an obvious fake.
 */

const CONFIGURED: Record<string, string> = {
  BREVO_API_KEY: 'fake-brevo-key-for-tests',
  MAIL_FROM: 'no-reply@example.com',
};

function makeMailer(values: Record<string, string>) {
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new MailerService(config);
}

describe('MailerService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('is unconfigured and sends nothing when the env is unset', async () => {
    const mailer = makeMailer({});
    expect(mailer.configured).toBe(false);
    await expect(
      mailer.sendPasswordResetCode('user@example.com', '123456'),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unconfigured when only one of the two values is set', async () => {
    const mailer = makeMailer({ BREVO_API_KEY: 'fake-brevo-key-for-tests' });
    expect(mailer.configured).toBe(false);
    await expect(
      mailer.sendPasswordResetCode('user@example.com', '123456'),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the code to Brevo when configured', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const mailer = makeMailer(CONFIGURED);
    expect(mailer.configured).toBe(true);
    await expect(
      mailer.sendPasswordResetCode('user@example.com', '123456'),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('fake-brevo-key-for-tests');
    const body = JSON.parse(init.body) as {
      sender: { email: string };
      to: { email: string }[];
      subject: string;
      textContent: string;
    };
    expect(body.sender.email).toBe('no-reply@example.com');
    expect(body.to).toEqual([{ email: 'user@example.com' }]);
    expect(body.textContent).toContain('123456');
    expect(body.textContent).toContain('15 minutes');
  });

  it('returns false (does not throw) when Brevo rejects the send', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const mailer = makeMailer(CONFIGURED);
    await expect(
      mailer.sendPasswordResetCode('user@example.com', '123456'),
    ).resolves.toBe(false);
  });

  it('returns false (does not throw) when Brevo is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const mailer = makeMailer(CONFIGURED);
    await expect(
      mailer.sendPasswordResetCode('user@example.com', '123456'),
    ).resolves.toBe(false);
  });
});
