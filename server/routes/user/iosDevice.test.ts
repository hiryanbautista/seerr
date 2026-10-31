// Fork-only: iOS device token registration through user notification settings.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import { Notification } from '@server/lib/notifications';
import iOSAgent from '@server/lib/notifications/agents/ios';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
});

setupTestDb();

const TOKEN = 'ab'.repeat(32);

async function login(email: string) {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .send({ email, password: 'test1234' });
  assert.strictEqual(res.status, 200);
  return { agent, url: `/user/${res.body.id}/settings/notifications` };
}

const devices = () =>
  getRepository(UserIOSDevice).find({ relations: { user: true } });

describe('iOS device token', () => {
  it('registers, keeps and returns the token', async () => {
    const { agent, url } = await login('demo@seerr.dev');

    // Stored lowercase.
    const post = await agent
      .post(url)
      .send({ iOSDeviceToken: TOKEN.toUpperCase() });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.body.iOSDeviceToken, TOKEN);

    // Saving other settings without a token must not drop it.
    await agent.post(url).send({ pgpKey: null });
    // Registering the same token again must not duplicate it.
    await agent.post(url).send({ iOSDeviceToken: TOKEN });

    const get = await agent.get(url);
    assert.strictEqual(get.body.iOSDeviceToken, TOKEN);
    assert.strictEqual((await devices()).length, 1);
  });

  it('moves a token to the user in the URL', async () => {
    const demo = await login('demo@seerr.dev');
    await demo.agent.post(demo.url).send({ iOSDeviceToken: TOKEN });
    const admin = await login('admin@seerr.dev');
    await admin.agent.post(admin.url).send({ iOSDeviceToken: TOKEN });

    const all = await devices();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].user.email, 'admin@seerr.dev');
  });

  it('ignores null', async () => {
    const { agent, url } = await login('demo@seerr.dev');
    await agent.post(url).send({ iOSDeviceToken: TOKEN });
    const res = await agent.post(url).send({ iOSDeviceToken: null });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await devices()).length, 1);
  });

  it('DELETE removes only that token from that user', async () => {
    const demo = await login('demo@seerr.dev');
    const other = 'cd'.repeat(32);
    await demo.agent.post(demo.url).send({ iOSDeviceToken: TOKEN });
    await demo.agent.post(demo.url).send({ iOSDeviceToken: other });
    const admin = await login('admin@seerr.dev');
    const adminToken = 'ef'.repeat(32);
    await admin.agent.post(admin.url).send({ iOSDeviceToken: adminToken });

    const del = (token: string) =>
      demo.agent.delete(`${demo.url}/ios-device`).send({ token });

    // Uppercase is normalised; only this device goes.
    assert.strictEqual((await del(TOKEN.toUpperCase())).status, 204);
    // Another user's token, or an unknown one: 204, no-op.
    assert.strictEqual((await del(adminToken)).status, 204);
    assert.strictEqual((await del('12'.repeat(32))).status, 204);
    assert.strictEqual((await del('nope')).status, 400);

    const left = await devices();
    assert.deepStrictEqual(left.map((d) => d.token).sort(), [
      other,
      adminToken,
    ]);
  });

  it('rejects an invalid token', async () => {
    const { agent, url } = await login('demo@seerr.dev');
    for (const bad of ['tok-1', 'ab'.repeat(31), 'zz'.repeat(32), '']) {
      const res = await agent.post(url).send({ iOSDeviceToken: bad });
      assert.strictEqual(res.status, 400, bad);
    }
    assert.strictEqual((await devices()).length, 0);
  });
});

describe('iOS agent', () => {
  it('returns false instead of throwing on a bad APNS_KEY', async () => {
    process.env.APNS_KEY = 'not-a-key';
    try {
      const sent = await new iOSAgent().send(Notification.MEDIA_PENDING, {
        subject: 'Test',
        notifySystem: false,
        notifyAdmin: false,
      });
      assert.strictEqual(sent, false);
    } finally {
      delete process.env.APNS_KEY;
    }
  });
});
