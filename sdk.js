/*
  Server-side entry point, for game extensions and other kempo (CMS) extensions that want to work with
  games in process rather than over HTTP. The browser-facing client is public/sdk.js, served at
  /game/sdk.js.

  As in kempo-files, these are the *data* operations. Whether the caller may do something is the
  routes' business, with one exception: pass `actorId` and the rules that belong to a game itself (only
  the owner invites, the owner cannot leave) are enforced here as well. Leave it off for server-side
  code that has already decided it is allowed.

  A game is not built with this; it is built *on* it. It is its own extension, declares a game type in
  its kempo-config.json, and supplies the rules as a module (see server/utils/types/types.js). What
  this exposes is what a game extension, or an extension that reacts to games, calls.
*/

export {
  createGame,
  getGame,
  listGames,
  listAllGames,
  updateGameDetails,
  deleteGame,
  invitePlayer,
  acceptInvite,
  declineInvite,
  removePlayer,
  leaveGame,
  transferOwnership,
  joinGame,
  saveGame,
  getSession,
} from './server/utils/games/games.js';

export { listTypes, getType } from './server/utils/types/types.js';
export { default as getManager } from './server/utils/live/getManager.js';

/*
  Saves every running game and stops it. Call it from a graceful shutdown: without it, up to one
  autosave interval of changes to a running game is lost when the process stops.
*/
export const shutdownGames = async () => (await import('./server/utils/live/getManager.js')).default().shutdown();

export { applyChanges } from './public/utils/changes.js';
