// Native iOS push notifications over APNs.
import apn from '@parse/node-apn';
import { IssueType, IssueTypeName } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { IOSPushDelivery } from '@server/entity/IOSPushDelivery';
import { User } from '@server/entity/User';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import type { NotificationAgentConfig } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, LessThan } from 'typeorm';
import { Notification, shouldSendAdminNotification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

const APNS_KEY_ID = 'XM2D77F47X';
const APNS_TEAM_ID = '3WQN577LHJ';
const APNS_TOPIC = 'io.ryanbautista.Overseerr';

type APNsEnv = 'production' | 'sandbox';

const providers: Partial<Record<APNsEnv, apn.Provider>> = {};
const getProvider = (env: APNsEnv): apn.Provider | undefined => {
  const key = process.env.APNS_KEY;
  if (!key) {
    return undefined;
  }
  // Accept the p8 body with or without its BEGIN/END lines.
  const body = key
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END)[^-]*-----/g, '')
    .trim();
  // Throws on an invalid key; send() catches it.
  providers[env] ??= new apn.Provider({
    token: {
      key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
    },
    production: env === 'production',
  });
  return providers[env];
};

const tokenTail = (token: string) => `…${token.slice(-6)}`;

let warnedEnv = false;
const primaryEnv = (): APNsEnv => {
  const value = (process.env.APNS_ENV ?? '').trim().toLowerCase();
  if (value === 'prod' || value === 'production') {
    return 'production';
  }
  if (!['', 'sandbox', 'development'].includes(value) && !warnedEnv) {
    warnedEnv = true;
    logger.warn(
      `Unrecognized APNS_ENV "${process.env.APNS_ENV}"; using sandbox`,
      { label: 'Notifications' }
    );
  }
  return 'sandbox';
};

type DeliveryAttempt = {
  ok: boolean;
  environment: APNsEnv;
  userId: number | null;
  token: string;
  type: string | null;
  reason: string | null;
};

const RECENT_LIMIT = 50;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Logging must never fail the send: errors only warn.
export const recordIOSDeliveries = async (
  attempts: DeliveryAttempt[]
): Promise<void> => {
  if (attempts.length === 0) {
    return;
  }
  try {
    const repository = getRepository(IOSPushDelivery);
    const now = new Date();
    await repository.insert(
      attempts.map(
        ({ token, ...attempt }) =>
          new IOSPushDelivery({
            ...attempt,
            createdAt: now,
            tokenSuffix: token.slice(-6),
          })
      )
    );
    await repository.delete({
      createdAt: LessThan(new Date(now.getTime() - RETENTION_MS)),
    });
  } catch (e) {
    logger.warn('Failed to record iOS push delivery', {
      label: 'Notifications',
      errorMessage: e.message,
    });
  }
};

const toAttempt = (row: IOSPushDelivery) => ({
  at: row.createdAt.toISOString(),
  ok: row.ok,
  environment: row.environment,
  userId: row.userId,
  token: `…${row.tokenSuffix}`,
  type: row.type,
  reason: row.reason,
});

export const getIOSDeliveryStatus = async () => {
  const repository = getRepository(IOSPushDelivery);
  const newest = { id: 'DESC' } as const;
  const [sent, failed, [oldest], [lastSuccess], [lastFailure], recent] =
    await Promise.all([
      repository.count({ where: { ok: true } }),
      repository.count({ where: { ok: false } }),
      repository.find({ order: { id: 'ASC' }, take: 1 }),
      repository.find({ where: { ok: true }, order: newest, take: 1 }),
      repository.find({ where: { ok: false }, order: newest, take: 1 }),
      repository.find({ order: newest, take: RECENT_LIMIT }),
    ]);
  const failure = lastFailure && toAttempt(lastFailure);
  return {
    since: (oldest?.createdAt ?? new Date()).toISOString(),
    sent,
    failed,
    lastSuccessAt: lastSuccess?.createdAt.toISOString() ?? null,
    lastFailure: failure
      ? {
          at: failure.at,
          reason: failure.reason,
          environment: failure.environment,
          userId: failure.userId,
          token: failure.token,
        }
      : null,
    recent: recent.map(toAttempt),
  };
};

class iOSAgent
  extends BaseAgent<NotificationAgentConfig>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentConfig {
    if (this.settings) {
      return this.settings;
    }

    return getSettings().notifications.agents.ios;
  }

  public shouldSend(): boolean {
    return this.getSettings().enabled;
  }

  private getAlert(type: Notification, payload: NotificationPayload) {
    const mediaType = payload.media
      ? payload.media.mediaType === MediaType.MOVIE
        ? 'movie'
        : 'series'
      : undefined;
    const quality = payload.request?.is4k ? '4K ' : '';
    const issueType = payload.issue
      ? payload.issue.issueType !== IssueType.OTHER
        ? `${IssueTypeName[payload.issue.issueType].toLowerCase()} issue`
        : 'issue'
      : undefined;

    const messages: Partial<Record<Notification, string>> = {
      [Notification.TEST_NOTIFICATION]: payload.message,
      [Notification.MEDIA_AUTO_REQUESTED]: `Automatically submitted a new ${quality}${mediaType} request.`,
      [Notification.MEDIA_APPROVED]: `Your ${quality}${mediaType} request has been approved.`,
      [Notification.MEDIA_AUTO_APPROVED]: `Automatically approved a new ${quality}${mediaType} request from ${payload.request?.requestedBy.displayName}.`,
      [Notification.MEDIA_AVAILABLE]: `Your ${quality}${mediaType} request is now available!`,
      [Notification.MEDIA_DECLINED]: `Your ${quality}${mediaType} request was declined.`,
      [Notification.MEDIA_FAILED]: `Failed to process ${quality}${mediaType} request.`,
      [Notification.MEDIA_PENDING]: `Approval required for a new ${quality}${mediaType} request from ${payload.request?.requestedBy.displayName}.`,
      [Notification.ISSUE_CREATED]: `A new ${issueType} was reported by ${payload.issue?.createdBy.displayName}.`,
      [Notification.ISSUE_COMMENT]: `${payload.comment?.user.displayName} commented on the ${issueType}.`,
      [Notification.ISSUE_RESOLVED]: `The ${issueType} was marked as resolved by ${payload.issue?.modifiedBy?.displayName}!`,
      [Notification.ISSUE_REOPENED]: `The ${issueType} was reopened by ${payload.issue?.modifiedBy?.displayName}.`,
    };

    return { title: payload.subject, body: messages[type] ?? '' };
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    // Xcode builds have sandbox tokens, so BadDeviceToken retries on the other environment.
    const primary = primaryEnv();
    const fallback: APNsEnv =
      primary === 'production' ? 'sandbox' : 'production';
    let devices: UserIOSDevice[] = [];
    // Final outcome per token; a fallback retry overwrites the first try.
    const outcomes = new Map<
      string,
      { ok: boolean; environment: APNsEnv; reason: string | null }
    >();
    const attempts: DeliveryAttempt[] = [];
    const record = (
      device: UserIOSDevice,
      outcome: { ok: boolean; environment: APNsEnv; reason: string | null }
    ) =>
      attempts.push({
        ...outcome,
        userId: device.user.id,
        token: device.token,
        type: Notification[type],
      });

    try {
      const userIds = new Set<number>();

      if (
        payload.notifyUser &&
        (payload.notifyUser.settings?.hasNotificationType(
          NotificationAgentKey.IOS,
          type
        ) ??
          true)
      ) {
        userIds.add(payload.notifyUser.id);
      }

      if (payload.notifyAdmin) {
        const users = await getRepository(User).find();
        users
          .filter(
            (user) =>
              (user.settings?.hasNotificationType(
                NotificationAgentKey.IOS,
                type
              ) ??
                true) &&
              shouldSendAdminNotification(type, user, payload)
          )
          .forEach((user) => userIds.add(user.id));
      }

      const deviceRepository = getRepository(UserIOSDevice);
      devices =
        userIds.size > 0
          ? await deviceRepository.find({
              where: { user: { id: In([...userIds]) } },
            })
          : [];

      if (devices.length === 0) {
        // A test with no registered device should report failure.
        return type !== Notification.TEST_NOTIFICATION;
      }

      if (!getProvider(primary)) {
        logger.warn('APNS_KEY is not set; skipping iOS notification', {
          label: 'Notifications',
        });
        devices.forEach((device) =>
          record(device, { ok: false, environment: primary, reason: 'NoKey' })
        );
        return false;
      }

      logger.debug('Sending iOS push notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
        devices: devices.length,
      });

      const note = new apn.Notification();
      note.alert = this.getAlert(type, payload);
      note.payload = {
        type: Notification[type],
        mediaId: payload.media?.tmdbId,
        mediaType: payload.media?.mediaType,
      };
      note.badge = 0;
      note.topic = APNS_TOPIC;

      const sendTo = async (env: APNsEnv, tokens: string[]) => {
        const provider = getProvider(env) as apn.Provider;
        const result = await provider.send(note, tokens);
        const badTokens: string[] = [];
        for (const sent of result.sent) {
          outcomes.set(sent.device, {
            ok: true,
            environment: env,
            reason: null,
          });
        }
        for (const failure of result.failed) {
          const reason =
            failure.response?.reason ?? failure.error?.message ?? 'Error';
          outcomes.set(failure.device, { ok: false, environment: env, reason });
          if (failure.status === 410) {
            await deviceRepository.delete({ token: failure.device });
          } else if (reason === 'BadDeviceToken') {
            badTokens.push(failure.device);
            continue;
          }
          logger.error('Error sending iOS notification', {
            label: 'Notifications',
            environment: env,
            token: tokenTail(failure.device),
            status: failure.status,
            reason,
          });
        }
        if (result.sent.length > 0) {
          logger.log(env === primary ? 'debug' : 'info', 'iOS push delivered', {
            label: 'Notifications',
            environment: env,
            devices: result.sent.length,
          });
        }
        return badTokens;
      };

      const badTokens = await sendTo(
        primary,
        devices.map((d) => d.token)
      );
      if (badTokens.length > 0) {
        const stillBad = await sendTo(fallback, badTokens);
        for (const token of stillBad) {
          logger.warn(
            'APNs rejected the device token in both production and sandbox',
            { label: 'Notifications', token: tokenTail(token) }
          );
        }
      }

      let failed = 0;
      for (const device of devices) {
        const outcome = outcomes.get(device.token) ?? {
          ok: false,
          environment: primary,
          reason: 'Error',
        };
        record(device, outcome);
        if (!outcome.ok) {
          failed++;
        }
      }
      devices = [];

      return failed === 0;
    } catch (e) {
      logger.error('Error sending iOS notification', {
        label: 'Notifications',
        errorMessage: e.message,
      });
      // Keep outcomes APNs already reported; anything else failed locally.
      devices.forEach((device) =>
        record(
          device,
          outcomes.get(device.token) ?? {
            ok: false,
            environment: primary,
            reason: 'Error',
          }
        )
      );
      return false;
    } finally {
      await recordIOSDeliveries(attempts);
    }
  }
}

export default iOSAgent;
