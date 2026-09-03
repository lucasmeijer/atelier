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

export function transcriptFollowingAfterScroll(wasFollowing: boolean, previousEnd: number, scrollTop: number, nextEnd: number): boolean {
  const threshold = 60;
  const atNextEnd = scrollTop >= nextEnd - threshold;
  const endMovedAway = nextEnd > previousEnd;
  const remainedAtPreviousEnd = scrollTop >= previousEnd - threshold;
  return atNextEnd || (wasFollowing && endMovedAway && remainedAtPreviousEnd);
}

export function shouldPositionTranscriptAfterSnapshot(hasBeenReady: boolean, selectedSinceLastReady: boolean): boolean {
  return !hasBeenReady || selectedSinceLastReady;
}
