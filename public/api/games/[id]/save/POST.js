import { requirePlayer } from '../../../../../server/utils/permissions/gate.js';
import getManager from '../../../../../server/utils/live/getManager.js';
import { send } from '../../../../../server/utils/http.js';

/*
  Save now. Owner only unless the game type allows any player to; the same rule the live connection
  applies to a `save` message, since this is the same action reached another way.
*/
export default async (request, response) => {
  const [error, session] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const manager = getManager();
  const live = manager.get(request.params?.id);
  if(!live) return send(response, [{ code: 409, msg: 'Only a game that is running can be saved' }, null]);

  const member = live.member(session.user.id);
  if(!member) return send(response, [{ code: 403, msg: 'You are not a player in this game' }, null]);
  if(member.role !== 'owner' && !live.type.allowPlayerSave) return send(response, [{ code: 403, msg: 'Only the owner can save this game' }, null]);

  send(response, await manager.save(live, { reason: 'requested', actorId: session.user.id }));
};
