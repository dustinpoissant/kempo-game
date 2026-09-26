import { requirePlayer } from '../../../server/utils/permissions/gate.js';
import { listGames } from '../../../server/utils/games/games.js';
import { send } from '../../../server/utils/http.js';

/*
  My games and my invitations, newest activity first. An invitation is a game with membership status
  `invited`; it is here so a lobby needs one call, not two.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);
  send(response, await listGames({ userId: session.user.id }));
};
