interface ScrollTranscript {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

interface TranscriptMessage {
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

export function scrollEnd(element: Pick<ScrollTranscript, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

export function workspaceSelectionScrollTop(transcript: ScrollTranscript, target: TranscriptMessage | null, busy: boolean): number {
  const end = scrollEnd(transcript);
  if (busy) return end;
  if (!target) return 0;
  const targetTop = transcript.scrollTop + target.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
  return Math.min(targetTop, end);
}

interface TranscriptScrollPosition {
  top: number;
  end: number;
}

export function transcriptFollowingAfterScroll(wasFollowing: boolean, previous: TranscriptScrollPosition, next: TranscriptScrollPosition): boolean {
  const atEnd = next.top > next.end - 1;
  if (!wasFollowing || next.top < previous.top) return atEnd;

  const threshold = 60;
  const endMovedAway = next.end > previous.end;
  const remainedAtPreviousEnd = next.top >= previous.end - threshold;
  return next.top >= next.end - threshold || (endMovedAway && remainedAtPreviousEnd);
}

export function shouldPositionTranscriptAfterSnapshot(hasBeenReady: boolean, selectedSinceLastReady: boolean): boolean {
  return !hasBeenReady || selectedSinceLastReady;
}
