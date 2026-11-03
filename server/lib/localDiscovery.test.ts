import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import { getSettings } from '@server/lib/settings';
import type * as LocalDiscovery from './localDiscovery';

type FakeService = {
  options: { name: string; type: string; port: number };
  txt: Record<string, string>;
  advertised: boolean;
};

type FakeResponder = {
  options?: { interface: string[] };
  services: FakeService[];
  shutDown: boolean;
};

// Each getResponder() call is a fresh responder, as in ciao once the previous
// one has been shut down.
const responders: FakeResponder[] = [];
let failAdvertise = false;

mock.module('@homebridge/ciao', {
  namedExports: {
    getResponder: (options?: FakeResponder['options']) => {
      const responder: FakeResponder & Record<string, unknown> = {
        options,
        services: [],
        shutDown: false,
        createService: (opts: FakeService['options'] & { txt: never }) => {
          const service: FakeService & Record<string, unknown> = {
            options: opts,
            txt: opts.txt,
            advertised: false,
            advertise: async () => {
              if (failAdvertise) {
                throw new Error('bind EADDRINUSE 0.0.0.0:5353');
              }
              service.advertised = true;
            },
            updateTxt: (txt: Record<string, string>) => {
              service.txt = txt;
            },
          };
          responder.services.push(service);
          return service;
        },
        shutdown: async () => {
          responder.shutDown = true;
        },
      };
      responders.push(responder);
      return responder;
    },
  },
});

let discovery: typeof LocalDiscovery;

before(async () => {
  discovery = await import('./localDiscovery');
});

afterEach(async () => {
  await discovery.stopLocalDiscovery();
  responders.length = 0;
  failAdvertise = false;
  delete process.env.MDNS_INTERFACE;
});

const open = () => responders.filter((r) => !r.shutDown);
const announced = () =>
  open().flatMap((r) => r.services.filter((s) => s.advertised));

const setup = (overrides: { title?: string; url?: string } = {}) => {
  const settings = getSettings();
  settings.network.localDiscovery = true;
  settings.main.applicationTitle = overrides.title ?? 'Home Seerr';
  settings.main.applicationUrl = overrides.url ?? '';
  return settings;
};

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
  it('announces and follows settings', async () => {
    const settings = setup();

    await discovery.startLocalDiscovery(5056);
    assert.strictEqual(announced().length, 1);
    const [first] = announced();
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
    assert.deepStrictEqual(announced(), [first]);
    assert.strictEqual(first.txt.url, 'https://seerr.example');

    // A rename re-announces under the new name.
    settings.main.applicationTitle = 'Seerr';
    await discovery.syncLocalDiscovery();
    assert.strictEqual(announced().length, 1);
    assert.strictEqual(announced()[0].options.name, 'Seerr');
    assert.strictEqual(responders[0].shutDown, true);

    // Stopping sends goodbyes through the responder.
    await discovery.stopLocalDiscovery();
    assert.strictEqual(open().length, 0);
  });

  it('shuts the responder down when toggled off, and back on', async () => {
    const settings = setup();
    await discovery.startLocalDiscovery(5055);

    settings.network.localDiscovery = false;
    await discovery.syncLocalDiscovery();
    assert.strictEqual(open().length, 0);
    assert.strictEqual(responders[0].shutDown, true);

    settings.network.localDiscovery = true;
    await discovery.syncLocalDiscovery();
    assert.strictEqual(open().length, 1);
    assert.strictEqual(announced().length, 1);
  });

  it('restricts to MDNS_INTERFACE', async () => {
    setup();
    process.env.MDNS_INTERFACE = 'br0, eth0';
    await discovery.startLocalDiscovery(5055);
    assert.deepStrictEqual(responders[0].options, {
      interface: ['br0', 'eth0'],
    });
  });

  it('skips a loopback HOST', async () => {
    setup();
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      await discovery.startLocalDiscovery(5055, host);
    }
    assert.strictEqual(responders.length, 0);
    await discovery.startLocalDiscovery(5055, '0.0.0.0');
    assert.strictEqual(announced().length, 1);
  });

  it('registers signal handlers once', async () => {
    setup();
    await discovery.startLocalDiscovery(5055);
    const count = process.listenerCount('SIGTERM');
    await discovery.startLocalDiscovery(5055);
    assert.strictEqual(process.listenerCount('SIGTERM'), count);
  });

  it('logs and keeps running when mDNS fails', async () => {
    setup();
    failAdvertise = true;
    await assert.doesNotReject(discovery.startLocalDiscovery(5055));
    assert.strictEqual(responders.length, 1);
    assert.strictEqual(responders[0].shutDown, true);
  });
});
