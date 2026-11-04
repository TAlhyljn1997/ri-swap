// Presentation-only sign-out flow. The server remains the revocation authority.
export function syncSignOutButton(button, signedIn) {
  button.hidden = !signedIn;
}

export function clearClientSession(state) {
  state.sessionEpoch += 1;
  state.token = null;
  state.me = null;
  state.businessLink = null;
  state.riYellowChallenge = null;
  state.offer = null;
  state.offerDetail = null;
  state.draftId = null;
  state.pendingAccept = null;
  state.knowledgeRequestId += 1;
  state.keys.clear();
  state.offerActionPending.clear();
  state.unsavedChanges = false;
}

// A 401 from the RI-SWAP session is not a provider logout. Leave unsent form
// values in the document; a fresh /api/me readback is required after sign-in.
export function recoverExpiredClientSession(state, status, code) {
  if (status !== 401 || code !== 'UNAUTHENTICATED') return false;
  if (!state.me && !state.token) return false;
  clearClientSession(state);
  state.sessionExpired = true;
  return true;
}

export function createSignOutFlow({ button, beforeRequest, request, onSuccess, onError }) {
  let pending = false;
  return async function signOut() {
    if (pending) return false;
    if (beforeRequest && !beforeRequest()) return false;
    pending = true;
    button.disabled = true;
    try {
      await request();
      await onSuccess();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
}
