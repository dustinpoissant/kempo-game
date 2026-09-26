import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';
import { listAllGames } from '../../../server/utils/games/games.js';
import { send } from '../../../server/utils/http.js';

/*
  Every game on the site, for the admin screen. Needs `game:admin`.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return send(response, [sessionError, null]);

  const [permissionError] = await requirePermission(session.token, 'game:admin');
  if(permissionError) return send(response, [permissionError, null]);

  const limit = Math.min(Number(request.query?.limit) || 200, 500);
  const offset = Number(request.query?.offset) || 0;
  send(response, await listAllGames({ limit, offset }));
};
