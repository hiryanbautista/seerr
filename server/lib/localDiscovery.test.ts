import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

import { getSettings } from '@server/lib/settings';
import type * as LocalDiscovery from './localDiscovery';

type FakeService = {
  options: { name: string; type: string; port: number };
  txt: Record<string, string>;
  advertised: boolean;
  destroyed: boolean;
};

const services: FakeService[] = [];
let failAdvertise = false;
let shutdowns = 0;

mock.module('@homebridge/ciao', {
  namedExports: {
    getResponder: () => ({
      createService: (options: FakeService['options'] & { txt: never }) => {
        const service: FakeService & Record<string, unknown> = {
          options,
          txt: options.txt,
          advertised: false,
          destroyed: false,
          advertise: async () => {
            if (failAdvertise) {
              throw new Error('bind EADDRINUSE 0.0.0.0:5353');
            }
            service.advertised = true;
          },
          destroy: async () => {
            service.destroyed = true;
          },
          updateTxt: (txt: Record<string, string>) => {
            service.txt = txt;
          },
        };
        services.push(service);
        return service;
      },
      shutdown: async () => {
        shutdowns++;
      },
    }),
  },
});

let discovery: typeof LocalDiscovery;

before(async () => {
  discovery = await import('./localDiscovery');
});

const live = () => services.filter((s) => s.advertised && !s.destroyed);

describe('buildTxt', () => {
  it('builds the TXT record and leaves url out when empty', () => {
    const base = {
      clientId: 'abc',
      applicationTitle: 'Seerr',
      version: '1.0.0',
    };
    assert.deepStrictEqual(
      discovery.buildTxt({ ...base, applicationUrl: '' }),
      { id: 'abc', name: 'Seerr', v: '1.0.0' }
    );
    assert.deepStrictEqual(
      discovery.buildTxt({ ...base, applicationUrl: 'https://seerr.example' }),
      { id: 'abc', name: 'Seerr', url: 'https://seerr.example', v: '1.0.0' }
    );
  });
});

describe('local discovery', () => {
  it('starts, follows settings and stops', async () => {
    const settings = getSettings();
    settings.network.localDiscovery = true;
    settings.main.applicationTitle = 'Home Seerr';
    settings.main.applicationUrl = '';

    await discovery.startLocalDiscovery(5056);
    assert.strictEqual(live().length, 1);
    const [first] = live();
    assert.deepStrictEqual(first.options, {
      name: 'Home Seerr',
      type: 'seerr',
      port: 5056,
      txt: first.txt,
    });
    assert.strictEqual(first.txt.id, settings.clientId);
    assert.strictEqual(first.txt.url, undefined);

    // A URL change updates the TXT record in place.
    settings.main.applicationUrl = 'https://seerr.example';
    await discovery.syncLocalDiscovery();
    assert.deepStrictEqual(live(), [first]);
    assert.strictEqual(first.txt.url, 'https://seerr.example');

    // A rename re-announces under the new name.
    settings.main.applicationTitle = 'Seerr';
    await discovery.syncLocalDiscovery();
    assert.strictEqual(first.destroyed, true);
    assert.strictEqual(live()[0].options.name, 'Seerr');

    // Toggle off withdraws, toggle on announces again.
    settings.network.localDiscovery = false;
    await discovery.syncLocalDiscovery();
    assert.strictEqual(live().length, 0);
    settings.network.localDiscovery = true;
    await discovery.syncLocalDiscovery();
    assert.strictEqual(live().length, 1);

    // Shutdown sends goodbyes through the responder.
    await discovery.stopLocalDiscovery();
    assert.strictEqual(shutdowns, 1);
  });

  it('logs and keeps running when mDNS fails', async () => {
    getSettings().network.localDiscovery = true;
    failAdvertise = true;
    const created = services.length;
    await assert.doesNotReject(discovery.startLocalDiscovery(5055));
    const attempted = services.slice(created);
    assert.strictEqual(attempted.length, 1);
    assert.strictEqual(attempted[0].destroyed, true);
    failAdvertise = false;
    await discovery.stopLocalDiscovery();
  });
});
