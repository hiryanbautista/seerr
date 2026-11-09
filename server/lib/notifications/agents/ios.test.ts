import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { IOSPushDelivery } from '@server/entity/IOSPushDelivery';
import { User } from '@server/entity/User';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import type * as IOSModule from './ios';

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

let ios: typeof IOSModule;
let iOSAgent: typeof IOSModule.default;

before(async () => {
  process.env.APNS_KEY = 'test-key';
  process.env.APNS_ENV = 'prod';
  ios = await import('./ios');
  iOSAgent = ios.default;
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

describe('iOS delivery status', () => {
  it('counts attempts and keeps only the token suffix', async () => {
    const before = await ios.getIOSDeliveryStatus();
    await ios.recordIOSDeliveries([
      {
        ok: true,
        environment: 'production',
        userId: 1,
        token: PROD,
        type: 'MEDIA_AVAILABLE',
        reason: null,
      },
    ]);
    await ios.recordIOSDeliveries([
      {
        ok: false,
        environment: 'sandbox',
        userId: 2,
        token: SANDBOX,
        type: 'MEDIA_APPROVED',
        reason: 'BadDeviceToken',
      },
    ]);
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.sent, before.sent + 1);
    assert.strictEqual(status.failed, before.failed + 1);
    assert.ok(status.lastSuccessAt);
    assert.deepStrictEqual(
      { ...status.lastFailure, at: undefined },
      {
        at: undefined,
        reason: 'BadDeviceToken',
        environment: 'sandbox',
        userId: 2,
        token: '…bbbbbb',
      }
    );
    // Newest first, and no full token anywhere.
    assert.strictEqual(status.recent[0].type, 'MEDIA_APPROVED');
    assert.strictEqual(status.recent[1].token, '…aaaaaa');
    assert.ok(!JSON.stringify(status).includes(PROD));
  });

  it('keeps the last 50 attempts', async () => {
    for (let i = 0; i < 60; i++) {
      await ios.recordIOSDeliveries([
        {
          ok: true,
          environment: 'production',
          userId: i,
          token: PROD,
          type: 'MEDIA_AVAILABLE',
          reason: null,
        },
      ]);
    }
    const { recent } = await ios.getIOSDeliveryStatus();
    assert.strictEqual(recent.length, 50);
    assert.strictEqual(recent[0].userId, 59);
  });

  it('records a fallback retry as one attempt with its final outcome', async () => {
    const before = await ios.getIOSDeliveryStatus();
    outcomes.production[SANDBOX] = 'BadDeviceToken';
    assert.strictEqual(await sendTest(SANDBOX), true);
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.sent, before.sent + 1);
    assert.strictEqual(status.failed, before.failed);
    const { at, userId, ...latest } = status.recent[0];
    assert.ok(at && userId);
    assert.deepStrictEqual(latest, {
      ok: true,
      environment: 'sandbox',
      token: '…bbbbbb',
      type: 'TEST_NOTIFICATION',
      reason: null,
    });
  });

  it('records a partial failure across two devices', async () => {
    const before = await ios.getIOSDeliveryStatus();
    outcomes.production[SANDBOX] = 'InternalServerError';
    assert.strictEqual(await sendTest(PROD, SANDBOX), false);
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.sent, before.sent + 1);
    assert.strictEqual(status.failed, before.failed + 1);
    assert.strictEqual(status.lastFailure?.reason, 'InternalServerError');
    assert.strictEqual(status.lastFailure?.token, '…bbbbbb');
  });

  it('records NoKey once per device', async () => {
    const before = await ios.getIOSDeliveryStatus();
    delete process.env.APNS_KEY;
    try {
      assert.strictEqual(await sendTest(PROD, SANDBOX), false);
    } finally {
      process.env.APNS_KEY = 'test-key';
    }
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.failed, before.failed + 2);
    assert.deepStrictEqual(
      status.recent.slice(0, 2).map((r) => r.reason),
      ['NoKey', 'NoKey']
    );
    assert.strictEqual(calls.length, 0);
  });

  it('keeps reported outcomes when sending throws midway', async () => {
    const before = await ios.getIOSDeliveryStatus();
    outcomes.production[SANDBOX] = 410;
    const remove = mock.method(
      getRepository(UserIOSDevice),
      'delete',
      async () => {
        throw new Error('database is locked');
      }
    );
    try {
      assert.strictEqual(await sendTest(PROD, SANDBOX), false);
    } finally {
      remove.mock.restore();
    }
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.sent, before.sent + 1);
    assert.strictEqual(status.failed, before.failed + 1);
    const byToken = Object.fromEntries(
      status.recent.slice(0, 2).map((r) => [r.token, [r.ok, r.reason]])
    );
    assert.deepStrictEqual(byToken, {
      '…aaaaaa': [true, null],
      '…bbbbbb': [false, 'Unregistered'],
    });
  });

  it('persists rows with only the token suffix', async () => {
    await ios.recordIOSDeliveries([
      {
        ok: true,
        environment: 'production',
        userId: 1,
        token: PROD,
        type: 'MEDIA_AVAILABLE',
        reason: null,
      },
    ]);
    const rows = await getRepository(IOSPushDelivery).find();
    assert.deepStrictEqual(
      rows.map((r) => r.tokenSuffix),
      ['aaaaaa']
    );
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.since, rows[0].createdAt.toISOString());
    assert.ok(Math.abs(Date.parse(status.recent[0].at) - Date.now()) < 60_000);
  });

  it('reports an empty table', async () => {
    const status = await ios.getIOSDeliveryStatus();
    assert.deepStrictEqual(
      { ...status, since: undefined },
      {
        since: undefined,
        sent: 0,
        failed: 0,
        lastSuccessAt: null,
        lastFailure: null,
        recent: [],
      }
    );
    assert.ok(Math.abs(Date.parse(status.since) - Date.now()) < 60_000);
  });

  it('prunes rows older than 30 days on insert', async () => {
    const day = 24 * 60 * 60 * 1000;
    const repository = getRepository(IOSPushDelivery);
    const row = (daysAgo: number) =>
      new IOSPushDelivery({
        createdAt: new Date(Date.now() - daysAgo * day),
        ok: true,
        environment: 'production',
        userId: 1,
        tokenSuffix: 'aaaaaa',
        type: 'MEDIA_AVAILABLE',
        reason: null,
      });
    await repository.save([row(31), row(29)]);
    await ios.recordIOSDeliveries([
      {
        ok: true,
        environment: 'production',
        userId: 1,
        token: PROD,
        type: 'MEDIA_AVAILABLE',
        reason: null,
      },
    ]);
    assert.strictEqual(await repository.count(), 2);
    const status = await ios.getIOSDeliveryStatus();
    assert.strictEqual(status.sent, 2);
    const age = Date.now() - Date.parse(status.since);
    assert.ok(age > 28 * day && age < 30 * day);
  });

  it('orders by createdAt, not insert order', async () => {
    const row = (createdAt: Date, tokenSuffix: string) =>
      new IOSPushDelivery({
        createdAt,
        ok: true,
        environment: 'production',
        userId: 1,
        tokenSuffix,
        type: 'MEDIA_AVAILABLE',
        reason: null,
      });
    const now = Date.now();
    // The newer attempt gets the lower id.
    await getRepository(IOSPushDelivery).save(row(new Date(now), 'newer1'));
    await getRepository(IOSPushDelivery).save(
      row(new Date(now - 60_000), 'older1')
    );
    const status = await ios.getIOSDeliveryStatus();
    assert.deepStrictEqual(
      status.recent.map((r) => r.token),
      ['…newer1', '…older1']
    );
    assert.strictEqual(status.lastSuccessAt, new Date(now).toISOString());
    assert.strictEqual(status.since, new Date(now - 60_000).toISOString());
  });

  it('still sends when the delivery log write fails', async () => {
    const insert = mock.method(
      getRepository(IOSPushDelivery),
      'insert',
      async () => {
        throw new Error('disk full');
      }
    );
    const warn = mock.method(logger, 'warn');
    try {
      assert.strictEqual(await sendTest(PROD), true);
      assert.ok(
        warn.mock.calls.some((c) =>
          String(c.arguments[0]).includes('record iOS push delivery')
        )
      );
    } finally {
      insert.mock.restore();
      warn.mock.restore();
    }
  });

  it('is admin only', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use(checkUser);
    app.use('/auth', authRoutes);
    // Imported here so it gets the mocked APNs module.
    const settingsRoutes = (await import('@server/routes/settings')).default;
    app.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
    getSettings().main.localLogin = true;

    const statusAs = async (email: string) => {
      const agent = request.agent(app);
      await agent.post('/auth/local').send({ email, password: 'test1234' });
      return agent.get('/settings/notifications/ios/status');
    };

    const admin = await statusAs('admin@seerr.dev');
    assert.strictEqual(admin.status, 200);
    assert.deepStrictEqual(Object.keys(admin.body).sort(), [
      'failed',
      'lastFailure',
      'lastSuccessAt',
      'recent',
      'sent',
      'since',
    ]);
    assert.strictEqual((await statusAs('demo@seerr.dev')).status, 403);
  });
});
