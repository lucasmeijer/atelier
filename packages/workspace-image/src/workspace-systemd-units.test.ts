import { expect, test } from "bun:test";
import { workspaceRuntimeUnits } from "./workspace-systemd-units.ts";

test("socket-activated Docker loads the workspace proxy environment", () => {
  const units = workspaceRuntimeUnits();
  const service = units["docker.service"].split("[Service]\n")[1]!;
  expect(service.split("\n")).toContain("EnvironmentFile=/.atelier/environment");
  expect(units["docker.socket"]).toContain("WantedBy=sockets.target");
});
