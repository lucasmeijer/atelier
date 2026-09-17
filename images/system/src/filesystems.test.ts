import { expect, test } from "bun:test";
import { filesystemFailure } from "./filesystems.ts";

test("accepts required kernel filesystems, including nodev entries", () => {
  expect(filesystemFailure("nodev\tsysfs\n\terofs\nnodev\toverlay\n")).toBeUndefined();
});

test.each([
  ["erofs", "nodev\toverlay\n"],
  ["overlay", "\terofs\n"],
  ["erofs, overlay", "\terofs_extra\n"],
])("reports missing %s support", (missing, available) => {
  const failure = filesystemFailure(available);
  expect(failure).toBe(`The Linux kernel that powers your Docker does not have ${missing}, which Atelier requires.`);
});
