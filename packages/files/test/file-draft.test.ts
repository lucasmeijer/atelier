import { expect, test } from "bun:test";
import { FileDraft, type SaveResult } from "../src/file-draft.ts";
import { editFileText, editorText } from "../src/editable-text.ts";
import { parseEditableFileResponse, fileSaveRequestSchema } from "../src/protocol.ts";
import { Value } from "typebox/value";

const file = { content: "original\r\n", revision: "r1", writable: true };

test("serializes writes and drains edits made during a save without observers", async () => {
  const requests: unknown[] = [];
  const first = Promise.withResolvers<SaveResult>();
  const draft = new FileDraft(file, async request => {
    requests.push(request);
    return requests.length === 1 ? first.promise : { revision: "r3" };
  });
  draft.edit("first\r\n");
  const saving = draft.flush();
  draft.edit("second\r\n");
  expect(draft.flush()).toBe(saving);
  expect(requests).toHaveLength(1);
  first.resolve({ revision: "r2" });
  await saving;
  expect(requests).toEqual([
    { content: "first\r\n", revision: "r1", force: false },
    { content: "second\r\n", revision: "r2", force: false },
  ]);
  expect(draft.dirty).toBe(false);
  expect(draft.revision).toBe("r3");
});

test("failed writes retain the draft and revision for retry", async () => {
  let fail = true;
  const draft = new FileDraft(file, async () => {
    if (fail) throw new Error("Offline");
    return { revision: "r2" };
  });
  draft.edit("unsaved");
  await draft.flush();
  expect(draft.error).toBe("Offline");
  expect(draft.content).toBe("unsaved");
  expect(draft.revision).toBe("r1");
  expect(draft.dirty).toBe(true);
  fail = false;
  await draft.flush();
  expect(draft.error).toBeUndefined();
  expect(draft.dirty).toBe(false);
});

test("conflicts retain edits until explicitly overwritten or discarded", async () => {
  const latest = { ...file, content: "external\r\n", revision: "r2" };
  const requests: unknown[] = [];
  const draft = new FileDraft(file, async request => {
    requests.push(request);
    return request.force ? { revision: "r3" } : { conflict: latest };
  });
  draft.edit("mine\r\n");
  await draft.flush();
  await draft.flush();
  expect(requests).toHaveLength(1);
  expect(draft.content).toBe("mine\r\n");
  expect(draft.conflict).toEqual(latest);
  await draft.flush(true);
  expect(draft.dirty).toBe(false);
  expect(draft.conflict).toBeUndefined();
  draft.edit("discard");
  draft.accept(latest);
  expect(draft.content).toBe(latest.content);
  expect(draft.dirty).toBe(false);
});

for (const separator of ["\n", "\r\n", "\r"]) {
  test(`preserves ${JSON.stringify(separator)} through edits and protocol`, () => {
    const content = `one${separator}two${separator}`;
    const read = parseEditableFileResponse({ ...file, content });
    const edited = editFileText(read.content, [{ from: 1, to: 1, insert: "X" }]);
    expect(edited).toBe(`oXne${separator}two${separator}`);
    expect(editFileText(content, [{ from: 4, to: 4, insert: "new\n" }])).toBe(`one${separator}new${separator}two${separator}`);
    expect(Value.Parse(fileSaveRequestSchema, { content: edited, revision: read.revision }).content).toBe(edited);
  });
}

test("preserves untouched mixed endings, BOM, astral text and missing final newline", () => {
  const content = "\ufeff😀a\r\nb\nc\rd";
  expect(editorText(content)).toBe("\ufeff😀a\nb\nc\nd");
  expect(editFileText(content, [{ from: 3, to: 4, insert: "A" }, { from: 9, to: 10, insert: "D" }])).toBe("\ufeff😀A\r\nb\nc\rD");
  expect(editFileText(content, [{ from: 4, to: 7, insert: "" }])).toBe("\ufeff😀ac\rd");
});

test("reconciles a persisted draft when the server saved but the acknowledgment was lost", () => {
  const draft = new FileDraft(file, async () => { throw new Error("unused"); });
  draft.edit("recovered\r\n");
  draft.changedOnDisk({ ...file, content: draft.content, revision: "r2" });
  expect(draft.dirty).toBe(false);
  expect(draft.conflict).toBeUndefined();
  expect(draft.revision).toBe("r2");
});

test("refresh during a write cannot replace the draft or introduce a spurious conflict", async () => {
  const result = Promise.withResolvers<SaveResult>();
  const draft = new FileDraft(file, () => result.promise);
  draft.edit("mine");
  const saving = draft.flush();
  draft.changedOnDisk({ ...file, content: "mine", revision: "r2" });
  expect(draft.savedContent).toBe(file.content);
  expect(draft.conflict).toBeUndefined();
  result.resolve({ revision: "r2" });
  await saving;
  expect(draft.content).toBe("mine");
  expect(draft.dirty).toBe(false);
});

test("explicit overwrite writes even when the desired text equals the original baseline", async () => {
  const requests: unknown[] = [];
  const draft = new FileDraft(file, async request => {
    requests.push(request);
    return { revision: "r3" };
  });
  draft.edit("mine");
  draft.changedOnDisk({ ...file, content: "external", revision: "r2" });
  draft.edit(file.content);
  await draft.flush(true);
  expect(requests).toEqual([{ content: file.content, revision: "r1", force: true }]);
  expect(draft.conflict).toBeUndefined();
});
