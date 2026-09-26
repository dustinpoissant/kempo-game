import { requirePlayer } from '../../../../server/utils/permissions/gate.js';
import { updateGameDetails } from '../../../../server/utils/games/games.js';
import { send } from '../../../../server/utils/http.js';

/*
  Rename a game or change its settings. Owner only: the operation enforces it, so it holds whoever calls.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const { name, settings } = request.body || {};
  send(response, await updateGameDetails({ gameId: request.params?.id, actorId: session.user.id, name, settings }));
};
