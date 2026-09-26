import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import { invitePlayer } from '../../../../../server/utils/games/games.js';
import { send } from '../../../../../server/utils/http.js';

/*
  Invite someone, by user id or by email. Owner only. Asking by email tells the owner whether an account
  exists for it, which is the price of being able to invite someone by the address you know.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const { userId, email } = request.body || {};
  send(response, await invitePlayer({ gameId: request.params?.id, userId, email, invitedBy: session.user.id }), 201);
};
