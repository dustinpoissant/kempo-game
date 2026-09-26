/*
  Stand-ins for the two things a running game depends on that a test wants to control: the clock, and the
  realtime layer. With them a game can be driven through half a minute of autosaves in a few milliseconds,
  and everything it publishes, sends and closes can be read back.

  The database is never faked. It is what a save is compared against, and a save that only ever meets a
  pretend database proves nothing.
*/

export const fakeClock = () => {
  let now = 1_000_000;
  let next = 1;
  const timers = new Map();

  const add = (fn, ms, repeat) => {
    const id = next++;
    timers.set(id, { fn, at: now + ms, every: repeat ? ms : null });
    return { id, unref(){} };
  };

  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: handle => timers.delete(handle?.id),
    clearInterval: handle => timers.delete(handle?.id),
    count: () => timers.size,

    advance: async (ms) => {
      const end = now + ms;
      for(;;){
        let due = null;
        for(const [id, timer] of timers){
          if(timer.at <= end && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if(!due) break;

        now = due.timer.at;
        if(due.timer.every) due.timer.at += due.timer.every;
        else timers.delete(due.id);
        await due.timer.fn();
      }
      now = end;
    },
  };
};

export const fakeRealtime = () => {
  const channels = new Map();
  const published = [];
  const direct = [];
  const closed = [];
  const removed = [];

  return {
    channels, published, direct, closed, removed,

    registerChannel: (options) => {
      const channel = `${options.owner}:${options.name}`;
      if(channels.has(channel)) return [{ code: 409, msg: 'exists' }, null];
      channels.set(channel, options);
      return [null, { channel }];
    },
    unregisterChannel: ({ channel }) => {
      removed.push(channel);
      return [null, { removed: channels.delete(channel), dropped: 0 }];
    },
    publish: async ({ channel, data }) => {
      if(!channels.has(channel)) return [{ code: 404, msg: 'gone' }, null];
      published.push({ channel, data });
      return [null, { id: null, delivered: 1 }];
    },
    sendToConnection: ({ connectionId, data }) => {
      direct.push({ connectionId, data });
      return [null, { delivered: true }];
    },
    closeConnection: ({ connectionId, code, reason }) => {
      closed.push({ connectionId, code, reason });
      return [null, { closed: true }];
    },

    patches: channel => published.filter(entry => entry.channel === channel && entry.data.t === 'patch').map(entry => entry.data),
  };
};
