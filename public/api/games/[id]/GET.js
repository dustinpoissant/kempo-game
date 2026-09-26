import { requirePlayer, hasPermission } from '../../../../server/utils/permissions/gate.js';
import { getGame } from '../../../../server/utils/games/games.js';
import { send } from '../../../../server/utils/http.js';

/*
  One game, for someone in it or invited to it (or an administrator). The saved `state` is left out on
  purpose: it is the game's own document, possibly large, and a player gets it through the live
  connection, which is what keeps it current.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const [getError, data] = await getGame({ gameId: request.params?.id });
  if(getError) return send(response, [getError, null]);

  const mine = data.players.find(player => player.userId === session.user.id && (player.status === 'joined' || player.status === 'invited'));
  if(!mine && !await hasPermission(session.token, 'game:admin')){
    return send(response, [{ code: 404, msg: 'Game not found' }, null]);
  }

  const { state, ...game } = data.game;
  send(response, [null, { game, players: data.players, live: data.live, membership: mine ? { role: mine.role, status: mine.status } : null }]);
};
