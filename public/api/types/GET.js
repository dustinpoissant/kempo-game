import { requirePlayer } from '../../../server/utils/permissions/gate.js';
import { listTypes } from '../../../server/utils/types/types.js';
import { send } from '../../../server/utils/http.js';

/*
  The kinds of game that can be created here: whatever the installed game extensions declared. Only what
  a screen needs to offer a choice, never the module path.
*/
export default async (request, response) => {
  const [error] = await requirePlayer(request);
  if(error) return send(response, [error, null]);

  const types = (await listTypes()).map(type => ({
    id: type.id,
    label: type.label,
    description: type.description,
    playUrl: type.playUrl,
    minPlayers: type.minPlayers,
    maxPlayers: type.maxPlayers,
    defaultSettings: type.defaultSettings,
  }));
  send(response, [null, { types }]);
};
