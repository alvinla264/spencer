export function getChannelDraftState(states, channelId) {
  let state = states.get(channelId);
  if (!state) {
    state = { drafts: [], recipient: null, recipientLocked: false, messageText: "", sending: false, renderers: new Set() };
    states.set(channelId, state);
  }
  return state;
}

export function discardEmptyChannelDraftState(states, channelId, state) {
  if (states.get(channelId) !== state) return;
  if (!state.drafts.length && !state.renderers.size && !state.messageText && !state.sending) states.delete(channelId);
}
