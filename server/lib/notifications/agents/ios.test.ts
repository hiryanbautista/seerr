import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import type IOSAgentType from './ios';

type Env = 'production' | 'sandbox';
type Outcome = 'ok' | 'BadDeviceToken' | 410 | 'InternalServerError';

let outcomes: Record<Env, Record<string, Outcome>>;
const calls: { env: Env; tokens: string[] }[] = [];

class FakeProvider {
  env: Env;
  constructor(options: { production: boolean }) {
    this.env = options.production ? 'production' : 'sandbox';
  }
  async send(_note: unknown, tokens: string[]) {
    calls.push({ env: this.env, tokens });
    const sent: { device: string }[] = [];
    const failed: {
      device: string;
      status: number;
      response: { reason: string };
    }[] = [];
    for (const device of tokens) {
      const outcome = outcomes[this.env][device] ?? 'ok';
      if (outcome === 'ok') {
        sent.push({ device });
      } else if (outcome === 410) {
        failed.push({
          device,
          status: 410,
          response: { reason: 'Unregistered' },
        });
      } else {
        failed.push({
          device,
          status: outcome === 'BadDeviceToken' ? 400 : 500,
          response: { reason: outcome },
        });
      }
    }
    return { sent, failed };
  }
}

mock.module('@parse/node-apn', {
  defaultExport: { Provider: FakeProvider, Notification: class {} },
});

let iOSAgent: typeof IOSAgentType;

before(async () => {
  process.env.APNS_KEY = 'test-key';
  process.env.APNS_ENV = 'prod';
  iOSAgent = (await import('./ios')).default;
});

setupTestDb();

const PROD = 'aa'.repeat(32);
const SANDBOX = 'bb'.repeat(32);

const sendTest = async (...tokens: string[]) => {
  const user = (await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  })) as User;
  const devices = getRepository(UserIOSDevice);
  for (const token of tokens) {
    await devices.save(new UserIOSDevice({ token, user }));
  }
  return new iOSAgent().send(Notification.TEST_NOTIFICATION, {
    subject: 'Test',
    message: 'Hello',
    notifyUser: user,
    notifySystem: false,
    notifyAdmin: false,
  });
};

const storedTokens = async () =>
  (await getRepository(UserIOSDevice).find()).map((d) => d.token).sort();

beforeEach(() => {
  outcomes = { production: {}, sandbox: {} };
  calls.length = 0;
});

describe('iOS agent APNs environments', () => {
  it('delivers on production without touching sandbox', async () => {
    assert.strictEqual(await sendTest(PROD), true);
    assert.deepStrictEqual(calls, [{ env: 'production', tokens: [PROD] }]);
  });

  it('retries a BadDeviceToken once on sandbox', async () => {
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    assert.strictEqual(await sendTest(PROD, SANDBOX), true);
    assert.deepStrictEqual(calls, [
      { env: 'production', tokens: [PROD, SANDBOX] },
      { env: 'sandbox', tokens: [SANDBOX] },
    ]);
    assert.deepStrictEqual(await storedTokens(), [PROD, SANDBOX]);
  });

  it('reports failure and keeps the token when both reject it', async () => {
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    outcomes.sandbox[SANDBOX] = 'BadDeviceToken';
    assert.strictEqual(await sendTest(SANDBOX), false);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(await storedTokens(), [SANDBOX]);
  });

  it('reports other errors without retrying', async () => {
    outcomes.production[PROD] = 'InternalServerError';
    assert.strictEqual(await sendTest(PROD), false);
    assert.strictEqual(calls.length, 1);
  });

  it('removes a token on 410 in either environment', async () => {
    outcomes.production[PROD] = 410;
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    outcomes.sandbox[SANDBOX] = 410;
    assert.strictEqual(await sendTest(PROD, SANDBOX), false);
    assert.deepStrictEqual(await storedTokens(), []);
  });

  it('reports a device that fails on both while another succeeds', async () => {
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    outcomes.sandbox[SANDBOX] = 'InternalServerError';
    assert.strictEqual(await sendTest(PROD, SANDBOX), false);
    assert.deepStrictEqual(calls, [
      { env: 'production', tokens: [PROD, SANDBOX] },
      { env: 'sandbox', tokens: [SANDBOX] },
    ]);
  });

  it('counts only the devices still failing after the retry', async () => {
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    assert.strictEqual(await sendTest(PROD, SANDBOX), true);
  });

  for (const value of ['sandbox', 'development', 'Sandbox', '']) {
    it(`sends to sandbox first when APNS_ENV is "${value}"`, async () => {
      process.env.APNS_ENV = value;
      try {
        outcomes.sandbox[PROD] = 'BadDeviceToken';
        assert.strictEqual(await sendTest(PROD), true);
        assert.deepStrictEqual(calls, [
          { env: 'sandbox', tokens: [PROD] },
          { env: 'production', tokens: [PROD] },
        ]);
      } finally {
        process.env.APNS_ENV = 'prod';
      }
    });
  }

  it('treats PRODUCTION as production', async () => {
    process.env.APNS_ENV = 'PRODUCTION';
    try {
      assert.strictEqual(await sendTest(PROD), true);
      assert.deepStrictEqual(calls, [{ env: 'production', tokens: [PROD] }]);
    } finally {
      process.env.APNS_ENV = 'prod';
    }
  });

  it('warns once about an unrecognized APNS_ENV and uses sandbox', async () => {
    const warn = mock.method(logger, 'warn');
    process.env.APNS_ENV = 'staging';
    try {
      await sendTest(PROD);
      await sendTest();
      assert.strictEqual(calls[0].env, 'sandbox');
      const envWarnings = warn.mock.calls.filter((c) =>
        String(c.arguments[0]).includes('APNS_ENV')
      );
      assert.strictEqual(envWarnings.length, 1);
      assert.match(String(envWarnings[0].arguments[0]), /"staging".*sandbox/);
    } finally {
      process.env.APNS_ENV = 'prod';
      warn.mock.restore();
    }
  });
});
