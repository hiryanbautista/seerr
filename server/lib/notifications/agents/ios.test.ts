import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import { Notification } from '@server/lib/notifications';
import { setupTestDb } from '@server/test/db';
import type IOSAgentType from './ios';

type Env = 'production' | 'sandbox';
type Outcome = 'ok' | 'BadDeviceToken' | 410 | 'InternalServerError';

// What each environment answers per token; missing means 'ok'.
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
});
