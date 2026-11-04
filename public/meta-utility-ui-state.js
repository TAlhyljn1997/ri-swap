const STATES = Object.freeze({
  image: Object.freeze(['UNAVAILABLE', 'READY_TO_SELECT', 'LOCAL_PREVIEW', 'CONSENT_REQUIRED', 'READY_TO_SEND', 'SENDING', 'RESULT', 'ERROR']),
  voice: Object.freeze(['UNAVAILABLE', 'PERMISSION_REQUIRED', 'RECORDING', 'EDIT_TRANSCRIPT', 'CONSENT_REQUIRED', 'READY_TO_SEND', 'SENDING', 'RESULT', 'ERROR']),
});

const ensure = (kind, state) => {
  if (!STATES[kind]?.includes(state)) throw new Error(`UTILITY_UI_STATE_INVALID:${kind}:${state}`);
  return state;
};

export function imageUiState({ available = false, selected = false, previewed = false, consent = false, sending = false, result = false, error = false } = {}) {
  if (!available) return 'UNAVAILABLE';
  if (error) return 'ERROR';
  if (result) return 'RESULT';
  if (sending) return 'SENDING';
  if (!selected) return 'READY_TO_SELECT';
  if (!previewed) return 'LOCAL_PREVIEW';
  if (!consent) return 'CONSENT_REQUIRED';
  return ensure('image', 'READY_TO_SEND');
}

const validTranscript = value => {
  const transcript = typeof value === 'string' ? value.trim() : '';
  return transcript.length > 0 && transcript.length <= 8000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(transcript);
};

export function voiceUiState({ available = false, permission = false, recording = false, transcript = '', transmissionConsent = false, sending = false, result = false, error = false } = {}) {
  if (!available) return 'UNAVAILABLE';
  if (error) return 'ERROR';
  if (result) return 'RESULT';
  if (sending) return 'SENDING';
  if (!permission) return 'PERMISSION_REQUIRED';
  if (recording) return 'RECORDING';
  if (!String(transcript).trim()) return 'EDIT_TRANSCRIPT';
  if (!validTranscript(transcript)) return 'ERROR';
  if (!transmissionConsent) return 'CONSENT_REQUIRED';
  return 'READY_TO_SEND';
}

export function applyUnavailableUtilityControls(root = document) {
  for (const id of [
    'product-image-input', 'product-image-consent', 'product-image-send',
    'voice-permission', 'voice-transcript', 'voice-transmission-consent', 'voice-send',
  ]) {
    const node = root.getElementById(id);
    if (node) node.disabled = true;
  }
  const preview = root.getElementById('product-image-preview');
  if (preview) preview.hidden = true;
  return Object.freeze({ image: imageUiState(), voice: voiceUiState() });
}
