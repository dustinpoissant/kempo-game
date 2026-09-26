import { connect as connectRealtime } from '/kempo/realtime.js';
import GameConnection from '/game/GameConnection.js';

/*
  Browser client, served at /game/sdk.js.

  Mirrors the server SDK's names so a call reads the same on either side, and returns the same
  [error, data] tuples the rest of kempo uses. `join` is the one that matters for play: it opens a game
  and resolves with a live connection to it.

    import { join } from '/game/sdk.js';

    const [error, game] = await join(gameId);
    game.onState(state => draw(state));
    game.onLive(live => drawPlayers(live.players));
    await game.send({ type: 'move', x: 3, y: 4 });
*/

const BASE = '/game/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) return [{ code: response.status, msg: data.error || response.statusText }, null];
    return [null, data];
  } catch(error) {
    return [{ code: 0, msg: error.message }, null];
  }
};

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

const enc = encodeURIComponent;

/*
  One realtime connection is shared by every game a page opens, and by anything else on the page that
  uses /kempo/realtime.js, if it hands its client in.
*/
let shared = null;

export const useRealtime = (client) => { shared = client; };

const realtime = () => {
  if(!shared) shared = connectRealtime();
  return shared;
};

/*
  Types, games and players
*/

export const listTypes = () => request('/types');
export const listGames = () => request('/games');
export const getGame = gameId => request(`/games/${enc(gameId)}`);
export const createGame = ({ type, name, settings }) => request('/games', json('POST', { type, name, settings }));
export const updateGame = (gameId, { name, settings }) => request(`/games/${enc(gameId)}`, json('PATCH', { name, settings }));
export const deleteGame = gameId => request(`/games/${enc(gameId)}`, { method: 'DELETE' });

export const invitePlayer = (gameId, { userId, email }) => request(`/games/${enc(gameId)}/invites`, json('POST', { userId, email }));
export const acceptInvite = gameId => request(`/games/${enc(gameId)}/accept`, json('POST'));
export const declineInvite = gameId => request(`/games/${enc(gameId)}/decline`, json('POST'));
export const leaveGame = gameId => request(`/games/${enc(gameId)}/leave`, json('POST'));
export const removePlayer = (gameId, userId) => request(`/games/${enc(gameId)}/players/${enc(userId)}`, { method: 'DELETE' });
export const transferOwnership = (gameId, userId) => request(`/games/${enc(gameId)}/transfer`, json('POST', { userId }));

/* Administrators only */
export const listAllGames = () => request('/all');

/*
  Playing. Resolves once the first snapshot has arrived, so the connection it hands back can be drawn
  straight away. It reconnects and resyncs on its own; `status` and `onStatus` say what it is doing.
*/
export const join = async (gameId, { timeout = 10000 } = {}) => {
  const [error, opened] = await request(`/games/${enc(gameId)}/join`, json('POST'));
  if(error) return [error, null];

  const connection = new GameConnection({
    realtime: realtime(),
    gameId,
    channel: opened.channel,
    rejoin: async () => {
      const [rejoinError, again] = await request(`/games/${enc(gameId)}/join`, json('POST'));
      return rejoinError ? null : again.channel;
    },
  });

  let timer;
  try {
    await Promise.race([
      connection.ready,
      new Promise((_, reject) => { timer = setTimeout(() => reject({ code: 504, msg: 'The game did not respond' }), timeout); }),
    ]);
  } catch(failure) {
    connection.close();
    return [{ code: failure?.code || 0, msg: failure?.msg || 'Could not join the game' }, null];
  } finally {
    clearTimeout(timer);
  }

  return [null, connection];
};

export { GameConnection };
