import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import { declineInvite } from '../../../../../server/utils/games/games.js';
import { send } from '../../../../../server/utils/http.js';

export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);
  send(response, await declineInvite({ gameId: request.params?.id, userId: session.user.id }));
};
