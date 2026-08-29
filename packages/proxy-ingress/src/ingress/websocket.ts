function isForwardableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999);
}

export function closeWebSocket(socket: Pick<WebSocket, "close">, code: number, reason: string): void {
  if (isForwardableCloseCode(code)) socket.close(code, reason);
  else socket.close();
}
