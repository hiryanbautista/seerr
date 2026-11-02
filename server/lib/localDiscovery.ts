// Announce this server on the LAN over DNS-SD (_seerr._tcp) so the
// iOS app can list it on its sign-in screen. Needs host networking in Docker.
import type { CiaoService, Responder } from '@homebridge/ciao';
import { getResponder } from '@homebridge/ciao';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';

export const SERVICE_TYPE = 'seerr';

// TXT keys are a contract with the iOS app: id, name, url (omitted when
// empty), v.
export const buildTxt = ({
  clientId,
  applicationTitle,
  applicationUrl,
  version,
}: {
  clientId: string;
  applicationTitle: string;
  applicationUrl: string;
  version: string;
}): Record<string, string> => ({
  id: clientId,
  name: applicationTitle,
  ...(applicationUrl ? { url: applicationUrl } : {}),
  v: version,
});

let port: number | undefined;
let responder: Responder | undefined;
let service: CiaoService | undefined;
let announcedName: string | undefined;
// Serialises syncs so quick toggles can't race each other.
let queue = Promise.resolve();

const withdraw = async () => {
  const current = service;
  service = undefined;
  announcedName = undefined;
  await current?.destroy();
};

const sync = async () => {
  if (port === undefined) {
    return;
  }
  const settings = getSettings();
  if (!settings.network.localDiscovery) {
    if (service) {
      await withdraw();
      logger.info('Local discovery stopped', { label: 'Local Discovery' });
    }
    return;
  }

  const name = settings.main.applicationTitle;
  const txt = buildTxt({
    clientId: settings.clientId,
    applicationTitle: name,
    applicationUrl: settings.main.applicationUrl,
    version: getAppVersion(),
  });

  // The instance name can't change in place, so re-announce on a rename.
  if (service && announcedName !== name) {
    await withdraw();
  }
  if (service) {
    service.updateTxt(txt);
    return;
  }

  responder ??= getResponder();
  service = responder.createService({ name, type: SERVICE_TYPE, port, txt });
  announcedName = name;
  await service.advertise();
  logger.info(`Announcing "${name}" as _${SERVICE_TYPE}._tcp on port ${port}`, {
    label: 'Local Discovery',
  });
};

/**
 * Applies the current settings: starts, updates or withdraws the announcement.
 * Never throws; mDNS trouble (port 5353 busy, no multicast) only logs.
 */
export const syncLocalDiscovery = (): Promise<void> =>
  (queue = queue.then(() =>
    sync().catch(async (e) => {
      logger.warn('Local discovery unavailable', {
        label: 'Local Discovery',
        errorMessage: e.message,
      });
      await withdraw().catch(() => undefined);
    })
  ));

/** Sends goodbye packets. Safe to call when nothing is announced. */
export const stopLocalDiscovery = async (): Promise<void> => {
  port = undefined;
  await queue;
  const current = responder;
  responder = undefined;
  service = undefined;
  announcedName = undefined;
  await current?.shutdown().catch(() => undefined);
};

export const startLocalDiscovery = (listenPort: number): Promise<void> => {
  port = listenPort;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      // Say goodbye, then re-raise so the process exits as it did before.
      // The timer caps how long shutdown can wait on the network.
      const exit = () => process.kill(process.pid, signal);
      setTimeout(exit, 2000).unref();
      stopLocalDiscovery().finally(exit);
    });
  }

  return syncLocalDiscovery();
};
