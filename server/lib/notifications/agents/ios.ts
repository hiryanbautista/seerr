// Fork-only: native iOS push notifications over APNs.
import apn from '@parse/node-apn';
import { IssueType, IssueTypeName } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserIOSDevice } from '@server/entity/UserIOSDevice';
import type { NotificationAgentConfig } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';
import { Notification, shouldSendAdminNotification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

const APNS_KEY_ID = 'XM2D77F47X';
const APNS_TEAM_ID = '3WQN577LHJ';
const APNS_TOPIC = 'io.ryanbautista.Overseerr';

// One provider for the whole process; it holds an HTTP/2 connection to APNs.
let provider: apn.Provider | undefined;
const getProvider = (): apn.Provider | undefined => {
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
  provider ??= new apn.Provider({
    token: {
      key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
    },
    production: process.env.APNS_ENV === 'prod',
  });
  return provider;
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
    try {
      const apnProvider = getProvider();
      if (!apnProvider) {
        logger.warn('APNS_KEY is not set; skipping iOS notification', {
          label: 'Notifications',
        });
        return false;
      }

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
      const devices =
        userIds.size > 0
          ? await deviceRepository.find({
              where: { user: { id: In([...userIds]) } },
            })
          : [];

      if (devices.length === 0) {
        // A test with no registered device should report failure.
        return type !== Notification.TEST_NOTIFICATION;
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

      const result = await apnProvider.send(
        note,
        devices.map((d) => d.token)
      );

      for (const failure of result.failed) {
        const reason = failure.response?.reason ?? failure.error?.message;
        logger.error('Error sending iOS notification', {
          label: 'Notifications',
          status: failure.status,
          reason,
        });
        // 410 = token no longer valid for this app; drop it.
        if (failure.status === 410) {
          await deviceRepository.delete({ token: failure.device });
        } else if (reason === 'BadDeviceToken') {
          // Keep the token: a wrong APNS_ENV makes every token fail this way,
          // and the app doesn't re-register, so deleting would lose them all.
          logger.warn(
            'APNs rejected the device token; APNS_ENV may not match the app build (sandbox vs production)',
            { label: 'Notifications' }
          );
        }
      }

      return result.failed.length === 0;
    } catch (e) {
      logger.error('Error sending iOS notification', {
        label: 'Notifications',
        errorMessage: e.message,
      });
      return false;
    }
  }
}

export default iOSAgent;
