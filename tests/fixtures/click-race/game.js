/*
  The rules of a game in the smallest form that exercises all of kempo-game: scores that change many
  times a second (`live`, never saved), and a result that must survive a restart (`state`, saved).

  It is the same module behind three declared types, which differ only in how they are configured.
*/

export const onCreate = ({ settings }) => ({ status: 'racing', winner: null, target: settings.target ?? 100, rounds: 0 });

export const onLoad = ({ session }) => {
  const scores = {};
  for(const player of session.players) scores[player.id] = 0;
  session.setLive({ scores, connects: 0 });
};

export const onConnect = ({ session, player }) => {
  if(session.live.scores[player.id] === undefined) session.live.scores[player.id] = 0;
  session.live.connects++;
};

export const onInput = ({ session, player, input }) => {
  if(input?.type === 'trackTicks'){
    session.live.trackTicks = true;
    return { ok: true };
  }
  if(input?.type === 'note'){
    session.state.note = input.text;
    return { ok: true };
  }
  if(input?.type === 'announce'){
    session.emit('announcement', { from: player.name, text: input.text });
    return { ok: true };
  }
  if(input?.type === 'whisper'){
    session.emit('whisper', { from: player.name, text: input.text }, { to: input.to });
    return { ok: true };
  }
  if(input?.type === 'throw') throw new Error('secret internal detail');
  if(input?.type === 'refuse') throw { code: 418, msg: 'No' };
  if(input?.type !== 'click') throw { code: 400, msg: 'Unknown input' };

  if(session.state.status === 'finished') throw { code: 409, msg: 'The race is over' };

  const scores = session.live.scores;
  scores[player.id] = (scores[player.id] || 0) + 1;

  if(scores[player.id] >= session.state.target){
    session.state.status = 'finished';
    session.state.winner = player.id;
    session.state.finalScores = { ...scores };
  }

  return { score: scores[player.id] };
};

export const onTick = ({ session }) => {
  if(session.live.trackTicks) session.live.ticks = (session.live.ticks || 0) + 1;
};

export const onSave = ({ session, save }) => {
  if(session.state.keepScores) save.state.savedScores = { ...session.live.scores };
};
