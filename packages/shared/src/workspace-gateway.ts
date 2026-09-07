// Wire contract with workspace-image/workspace-image/gateway/main.go.
export const workspaceGatewayPort = 2999;
export const workspaceGatewayHostHeader = "x-atelier-gateway-host";
export const workspaceGatewayTokenHeader = "x-atelier-gateway-token";
export const workspaceGatewayPortHeader = "x-atelier-gateway-port";
export const workspaceGatewayProtocolHeader = "x-atelier-gateway-protocol";

// Response-only marker, stripped from app responses by the gateway.
export const workspaceGatewayErrorHeader = "x-atelier-gateway-error";

export function isWorkspaceAppPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== workspaceGatewayPort;
}

export interface WorkspaceGateway {
  /** Docker-host loopback URL of the workspace's sole published gateway. */
  url: URL;
  token: string;
}
