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

function messageScrollTop(transcript: ScrollTranscript, message: TranscriptMessage): number {
  return transcript.scrollTop + message.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
}

function messageScrollTarget(transcript: ScrollTranscript, message: TranscriptMessage): number {
  return Math.min(messageScrollTop(transcript, message), scrollEnd(transcript));
}

export function workspaceSelectionScrollTop(transcript: ScrollTranscript, target: TranscriptMessage | null, busy: boolean): number {
  if (busy) return scrollEnd(transcript);
  return target ? messageScrollTarget(transcript, target) : 0;
}

export function scrollMessageToTop(transcript: ScrollTranscript & Pick<HTMLElement, "scrollTo">, message: TranscriptMessage): void {
  transcript.scrollTo({ top: messageScrollTarget(transcript, message), behavior: "smooth" });
}

export function messageNavigationDirection(transcript: ScrollTranscript, message: TranscriptMessage): "up" | "down" | undefined {
  const distance = transcript.scrollTop - messageScrollTarget(transcript, message);
  return Math.abs(distance) < 1 ? undefined : distance > 0 ? "up" : "down";
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
