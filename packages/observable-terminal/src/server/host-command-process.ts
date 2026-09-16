// Executed inside tmux. A separate process group lets the owner cancel the
// command and its children without killing tmux or another workspace's session.
const child = Bun.spawn(["bash", "-lc", process.argv[2]!], {
  detached: true,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);

export {};
