import { requirePlayer } from '../../../server/utils/permissions/gate.js';
import { createGame } from '../../../server/utils/games/games.js';
import { send } from '../../../server/utils/http.js';

export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const { type, name, settings } = request.body || {};
  send(response, await createGame({ ownerId: session.user.id, type, name, settings }), 201);
};
