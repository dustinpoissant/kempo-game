import getManager from '../server/utils/live/getManager.js';
import { CHANNEL_PREFIX } from '../server/utils/live/Manager.js';

/*
  A player's connection has subscribed to a game's channel: they are now online in that game.

  Core fires this after the subscription is granted and does not wait for it, so it never delays the
  socket. It fires for every channel on the site, so the first thing it does is ignore the ones that are
  not a game's.
*/
export default async ({ channel, userId, connectionId }) => {
  if(typeof channel !== 'string' || !channel.startsWith(CHANNEL_PREFIX)) return;
  await getManager().connected({ channel, userId, connectionId });
};
