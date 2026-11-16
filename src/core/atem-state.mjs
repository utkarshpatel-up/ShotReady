// The small part of the ATEM's state ShotReady uses: live video mode, input labels, program and
// preview per M/E, and the switcher's name. Used in the ATEM's own thread and, as a fallback, on the
// main thread.
const MODE_LABEL = { P4KHDp25: '2160p25', P1080p25: '1080p25' };

export function readAtemState(state, VideoMode) {
  const name = VideoMode[state?.settings?.videoMode];
  const inputs = {};
  for (const [id, input] of Object.entries(state?.inputs || {})) {
    if (input) inputs[id] = input.longName || '';
  }
  const mixEffects = (state?.video?.mixEffects || []).filter(Boolean).map((m) => ({
    program: m.programInput, preview: m.previewInput,
  }));
  return { modeName: name || null, modeLabel: MODE_LABEL[name] || name || 'unknown', inputs, mixEffects, name: state?.info?.productIdentifier || '' };
}
