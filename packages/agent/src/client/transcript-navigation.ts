interface ScrollTranscript {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

interface TranscriptMessage {
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

function scrollEnd(element: Pick<ScrollTranscript, "scrollHeight" | "clientHeight">): number {
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
  height: number;
}

export function transcriptScrollPosition(element: Pick<ScrollTranscript, "scrollTop" | "scrollHeight" | "clientHeight">): TranscriptScrollPosition {
  return { top: element.scrollTop, end: scrollEnd(element), height: element.clientHeight };
}

export function transcriptFollowingAfterScroll(wasFollowing: boolean, previous: TranscriptScrollPosition, next: TranscriptScrollPosition): boolean {
  const atEnd = next.top > next.end - 1;
  if (!wasFollowing) return atEnd;

  // Viewport expansion clamps the old bottom upward, even if output has already
  // moved the end away again. Only movement above that clamp is user navigation.
  const expandedBy = next.height - previous.height;
  const clampedTop = Math.max(0, Math.min(previous.top, previous.end - expandedBy));
  if (expandedBy > 0 && next.top >= clampedTop) return true;
  if (next.top < previous.top) return atEnd;

  const threshold = 60;
  const endMovedAway = next.end > previous.end;
  const remainedAtPreviousEnd = next.top >= previous.end - threshold;
  return next.top >= next.end - threshold || (endMovedAway && remainedAtPreviousEnd);
}
