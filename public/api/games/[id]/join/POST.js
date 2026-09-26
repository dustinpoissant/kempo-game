import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import { joinGame } from '../../../../../server/utils/games/games.js';
import { send } from '../../../../../server/utils/http.js';

/*
  Open the game for play. It is made live on this process if it is not already, and the response names the
  channel to subscribe to. The client then subscribes and asks for a snapshot; see public/sdk.js.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);
  send(response, await joinGame({ gameId: request.params?.id, userId: session.user.id }));
};
