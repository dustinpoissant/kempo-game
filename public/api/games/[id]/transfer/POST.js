import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import { transferOwnership } from '../../../../../server/utils/games/games.js';
import { send } from '../../../../../server/utils/http.js';

export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const { userId } = request.body || {};
  send(response, await transferOwnership({ gameId: request.params?.id, toUserId: userId, actorId: session.user.id }));
};
