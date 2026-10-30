// Fork-only: iOS device token registration through user notification settings.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
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

describe('iOS device token', () => {
  it('registers, keeps and returns the token', async () => {
    getSettings().main.localLogin = true;
    const agent = request.agent(app);
    const login = await agent
      .post('/auth/local')
      .send({ email: 'demo@seerr.dev', password: 'test1234' });
    assert.strictEqual(login.status, 200);
    const url = `/user/${login.body.id}/settings/notifications`;

    const post = await agent.post(url).send({ iOSDeviceToken: 'tok-1' });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.body.iOSDeviceToken, 'tok-1');

    // Saving other settings without a token must not drop it.
    await agent.post(url).send({ pgpKey: null });
    // Registering the same token again must not duplicate it.
    await agent.post(url).send({ iOSDeviceToken: 'tok-1' });

    const get = await agent.get(url);
    assert.strictEqual(get.body.iOSDeviceToken, 'tok-1');
    assert.strictEqual(await getRepository(UserIOSDevice).count(), 1);
  });
});
