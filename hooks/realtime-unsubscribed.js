import getManager from '../server/utils/live/getManager.js';
import { CHANNEL_PREFIX } from '../server/utils/live/Manager.js';

/*
  A connection left a game's channel, by unsubscribing or by disconnecting (core fires this for every
  channel a closing connection was on). When it was the player's last connection they go offline.
*/
export default async ({ channel, userId, connectionId }) => {
  if(typeof channel !== 'string' || !channel.startsWith(CHANNEL_PREFIX)) return;
  await getManager().disconnected({ channel, userId, connectionId });
};
