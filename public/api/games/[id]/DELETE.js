import { requireSession, requirePermission, hasPermission } from '../../../../server/utils/permissions/gate.js';
import { deleteGame } from '../../../../server/utils/games/games.js';
import { send } from '../../../../server/utils/http.js';

/*
  Delete a game and everyone's place in it. The owner may; so may an administrator, who is not
  necessarily in the game and so is not an `actor` as far as the operation's ownership rule goes.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return send(response, [sessionError, null]);

  const admin = await hasPermission(session.token, 'game:admin');
  if(!admin){
    const [permissionError] = await requirePermission(session.token, 'game:play');
    if(permissionError) return send(response, [permissionError, null]);
  }

  send(response, await deleteGame({ gameId: request.params?.id, actorId: admin ? undefined : session.user.id }));
};
