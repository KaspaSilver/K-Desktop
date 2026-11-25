// One voice at a time, recorders included (K 961fc05a VoicePlaybackCoordinator, audit 2026-11-25
// B8). Every voice player goes through here: the 1:1, group and room bubbles (buildVoicePlayer)
// and the composers' previews (1:1, group, room). A player calls `willStart(owner, stop)` right
// before it plays - whichever was playing is stopped - and `didStop(owner)` when it pauses, ends or
// goes away. A recorder calls `recordingWillStart(token)` when it starts: any note playing stops,
// and none starts until `recordingDidEnd(token)`.
//
// K's audio-session half (handing the session back so music resumes) has no browser equivalent:
// a page doesn't hold the device's audio.

export function createVoicePlaybackCoordinator() {
  let owner = null;
  let stopCurrent = null;
  const recordings = new Set();

  function stopPrevious() {
    const stop = stopCurrent;
    owner = null;
    stopCurrent = null;
    if (stop) { try { stop(); } catch { /* already stopped */ } }
  }

  return {
    /** Stops whatever is playing and makes `who` the one playing. False while a recording is in
     *  progress: the caller doesn't play. */
    willStart(who, stop) {
      if (recordings.size > 0) return false;
      if (owner !== null && owner !== who) stopPrevious();
      owner = who;
      stopCurrent = typeof stop === "function" ? stop : null;
      return true;
    },
    /** `who` paused, ended or went away. Nothing for anyone else. */
    didStop(who) {
      if (owner !== who) return;
      owner = null;
      stopCurrent = null;
    },
    recordingWillStart(token) {
      recordings.add(token ?? recordings.size);
      stopPrevious();
    },
    recordingDidEnd(token) {
      recordings.delete(token);
    },
    get isRecording() { return recordings.size > 0; },
    get current() { return owner; },
  };
}

/** The app's one coordinator. */
export const voicePlayback = createVoicePlaybackCoordinator();
