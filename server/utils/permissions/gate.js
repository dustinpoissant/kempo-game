import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  Who is asking, and whether they may. Every route starts here, so a check is never written out
  longhand in one file and forgotten in another.

  Membership of a particular game is not decided here. That is enforced by the operations themselves,
  which take the caller as `actorId`, so it holds for the routes and for anything calling the SDK.
*/

export const requireSession = async (request) => {
  const token = request.cookies?.session_token;
  if(!token) return [{ code: 401, msg: 'Authentication required' }, null];

  const [error, session] = await getSession({ token });
  if(error || !session?.user) return [{ code: 401, msg: 'Authentication required' }, null];

  return [null, { token, user: session.user }];
};

export const requirePermission = async (token, name) => {
  const [error, allowed] = await currentUserHasPermission(token, name);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'Insufficient permissions' }, null];
  return [null, true];
};

export const hasPermission = async (token, name) => {
  const [error, allowed] = await currentUserHasPermission(token, name);
  return Boolean(!error && allowed);
};

/*
  The common case: a signed-in user who may play.
*/
export const requirePlayer = async (request) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return [sessionError, null];

  const [permissionError] = await requirePermission(session.token, 'game:play');
  if(permissionError) return [permissionError, null];

  return [null, session];
};
