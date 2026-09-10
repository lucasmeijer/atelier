import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { dockerRuntimeConnectionSchema, dockerRegistryAddress, loopbackRegistryAddress, registryAddressSchema, type DockerRuntimeConnection } from "./runtime-connection.ts";

test("only a MagicDNS name and valid port can cross the inherited registry connection", () => {
  expect(Value.Check(registryAddressSchema, "atelier.tail123abc.ts.net:42000")).toBe(true);
  for (const address of ["100.64.0.1:42000", "127.0.0.1:42000", "0.0.0.0:42000", "atelier.example.com:42000", "atelier.tailnet.ts.net:0", "atelier.tailnet.ts.net:65536", "atelier.tailnet.ts.net:42000/path"]) {
    expect(Value.Check(registryAddressSchema, address)).toBe(false);
  }
});

test("host Docker uses loopback, nested creators use Serve, and BuildKit always uses owner loopback", () => {
  const registryAddress = "atelier.tailnet.ts.net:42000";
  const connection: DockerRuntimeConnection = { version: 1, depth: 0, adminSocket: "/s/admin.sock", socketDirectory: "/s", snapshotterRoot: "/store", buildServices: { buildkitSocket: "/s/buildkit.sock", registryAddress } };
  expect(dockerRegistryAddress(connection)).toBe("127.0.0.1:42000");
  for (const depth of [1, 2, 11]) expect(dockerRegistryAddress({ ...connection, depth })).toBe(registryAddress);
  expect(loopbackRegistryAddress(registryAddress)).toBe("127.0.0.1:42000");
});


test("runtime descriptors carry optional validated workspace ownership", () => {
  const connection: DockerRuntimeConnection = { version: 1, depth: 0, adminSocket: "/s/admin.sock", socketDirectory: "/s", snapshotterRoot: "/store" };
  expect(Value.Check(dockerRuntimeConnectionSchema, connection)).toBe(true);
  expect(Value.Check(dockerRuntimeConnectionSchema, { ...connection, depth: 1, clientId: "abcdef0123456789abcdef01" })).toBe(true);
  for (const clientId of ["", "../parent", "ABCDEF0123456789ABCDEF01", "abcdef", "abcdef0123456789abcdef012"]) {
    expect(Value.Check(dockerRuntimeConnectionSchema, { ...connection, clientId })).toBe(false);
  }
});
