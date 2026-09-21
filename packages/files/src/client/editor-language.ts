import type { Extension } from "@codemirror/state";
import { shaderLanguageFromExtension } from "@atelier/syntax/shader-languages";

export async function languageExtension(path: string): Promise<Extension> {
  const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"].includes(extension)) return (await import("@codemirror/lang-javascript")).javascript({ typescript: ["ts", "mts", "cts", "tsx"].includes(extension), jsx: ["jsx", "tsx"].includes(extension) });
  if (["json", "jsonc"].includes(extension)) return (await import("@codemirror/lang-json")).json();
  if (["html", "htm"].includes(extension)) return (await import("@codemirror/lang-html")).html();
  if (["css"].includes(extension)) return (await import("@codemirror/lang-css")).css();
  if (["md", "markdown"].includes(extension)) return (await import("@codemirror/lang-markdown")).markdown();
  if (["py"].includes(extension)) return (await import("@codemirror/lang-python")).python();
  if (["rs"].includes(extension)) return (await import("@codemirror/lang-rust")).rust();
  if (["java"].includes(extension)) return (await import("@codemirror/lang-java")).java();
  if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(extension)) return (await import("@codemirror/lang-cpp")).cpp();
  const shader = shaderLanguageFromExtension(extension);
  if (shader) return (await import("./shader-language.ts")).shaderLanguage(shader);
  const { StreamLanguage } = await import("@codemirror/language");
  if (extension === "rb") return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
  if (extension === "go") return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go);
  if (["sh", "bash", "zsh"].includes(extension)) return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
  return [];
}
