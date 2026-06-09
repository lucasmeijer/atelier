export type AgentClientMessage =
  | { type: "submit"; text: string }
  | { type: "abort" };

export type AgentRenderOp =
  | { type: "replace_html"; target: string; html: string }
  | { type: "append_html"; target: string; html: string }
  | { type: "append_text"; target: string; text: string }
  | { type: "set_submit_label"; label: "Send" | "Steer"; disabled?: boolean }
  | { type: "notice"; level: "info" | "error"; message: string };
