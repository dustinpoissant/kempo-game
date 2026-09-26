import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import { acceptInvite } from '../../../../../server/utils/games/games.js';
import { send } from '../../../../../server/utils/http.js';

export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);
  send(response, await acceptInvite({ gameId: request.params?.id, userId: session.user.id }));
};
