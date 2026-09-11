import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { dockerRuntimeConnectionSchema, dockerRegistryAddress, registryAddress, registryAddressSchema, type DockerRuntimeConnection } from "./runtime-connection.ts";

test("only the fixed registry hostname and port can cross the inherited connection", () => {
  expect(Value.Check(registryAddressSchema, registryAddress)).toBe(true);
  for (const address of ["127.0.0.1:42000", "atelier-registry.localhost:42001", "100.64.0.1:42000", "atelier.tail123abc.ts.net:42000", "0.0.0.0:42000", "atelier.example.com:42000", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:42000/path"]) {
    expect(Value.Check(registryAddressSchema, address)).toBe(false);
  }
});

test("runtime descriptors carry optional validated workspace ownership", () => {
  const connection: DockerRuntimeConnection = { version: 1, depth: 0, adminSocket: "/s/admin.sock", socketDirectory: "/s", snapshotterRoot: "/store" };
  expect(Value.Check(dockerRuntimeConnectionSchema, connection)).toBe(true);
  expect(Value.Check(dockerRuntimeConnectionSchema, { ...connection, depth: 1, clientId: "abcdef0123456789abcdef01" })).toBe(true);
  for (const clientId of ["", "../parent", "ABCDEF0123456789ABCDEF01", "abcdef", "abcdef0123456789abcdef012"]) {
    expect(Value.Check(dockerRuntimeConnectionSchema, { ...connection, clientId })).toBe(false);
  }
});

test("host Docker uses numeric loopback but nested Docker uses the canonical hostname", () => {
  const connection: DockerRuntimeConnection = {version: 1, depth: 0, adminSocket: "/s/admin.sock", socketDirectory: "/s", snapshotterRoot: "/store", buildServices: {buildkitSocket: "/s/buildkit.sock", registryAddress}};
  expect(dockerRegistryAddress(connection)).toBe("127.0.0.1:42000");
  for (const depth of [1, 2, 11]) expect(dockerRegistryAddress({...connection, depth})).toBe(registryAddress);
});
