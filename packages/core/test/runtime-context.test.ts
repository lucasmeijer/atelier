import { expect, test } from "bun:test";
import { getAtelierRuntimeContext, resetAtelierRuntimeContextForTests } from "@atelier/core";

test.skipIf(process.platform !== "darwin")("Docker containers reach a native macOS Atelier through host.docker.internal", () => {
  resetAtelierRuntimeContextForTests();
  expect(getAtelierRuntimeContext().dockerBridgeHost).toBe("host.docker.internal");
  resetAtelierRuntimeContextForTests();
});
