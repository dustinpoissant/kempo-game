import { requirePlayer } from '../../../../../../server/utils/permissions/gate.js';
import { removePlayer } from '../../../../../../server/utils/games/games.js';
import { send } from '../../../../../../server/utils/http.js';

/*
  Remove a player, or withdraw an invitation. The owner may remove anyone but themselves; a player may
  remove only themselves (which is leaving). The operation decides, so this cannot drift from the SDK.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);
  send(response, await removePlayer({ gameId: request.params?.id, userId: request.params?.userId, actorId: session.user.id }));
};
