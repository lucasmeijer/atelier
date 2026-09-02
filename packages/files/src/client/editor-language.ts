import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { clike, shader as glsl } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { shaderLanguageFromExtension } from "@atelier/syntax/shader-languages";

function wordSet(source: string): Record<string, true> {
  return Object.fromEntries(source.split(" ").map((word) => [word, true]));
}

const hlsl = clike({
  name: "hlsl",
  keywords: wordSet("asm break case cbuffer centroid class column_major compile compile_fragment const continue default discard do else export extern for groupshared if in inline inout interface line lineadj linear namespace nointerpolation noperspective out packoffset pass pixelfragment precise rasterizer_ordered register return row_major sample shared snorm stateblock stateblock_state static struct switch technique technique10 technique11 texture typedef uniform unorm unsigned vertexfragment volatile while"),
  types: wordSet("void bool bool2 bool3 bool4 double double2 double3 double4 dword dword2 dword3 dword4 float float2 float3 float4 half half2 half3 half4 int int2 int3 int4 min10float min12int min16float min16int min16uint uint uint2 uint3 uint4 string vector matrix Buffer ByteAddressBuffer ConsumeStructuredBuffer InputPatch OutputPatch RWBuffer RWByteAddressBuffer RWStructuredBuffer StructuredBuffer Texture1D Texture1DArray Texture2D Texture2DArray Texture2DMS Texture2DMSArray Texture3D TextureCube TextureCubeArray sampler sampler1D sampler2D sampler3D samplerCUBE SamplerState SamplerComparisonState"),
  blockKeywords: wordSet("do else for if struct switch while"),
  atoms: wordSet("true false NULL"),
});

const streamLanguages = {
  glsl: StreamLanguage.define(glsl),
  hlsl: StreamLanguage.define(hlsl),
  ruby: StreamLanguage.define(ruby),
  go: StreamLanguage.define(go),
  shell: StreamLanguage.define(shell),
};

function extensionOf(path: string): string {
  return path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
}

export function languageExtension(path: string): Extension {
  const extension = extensionOf(path);
  if (["js", "mjs", "cjs", "jsx"].includes(extension)) return javascript({ jsx: extension === "jsx" });
  if (["ts", "mts", "cts", "tsx"].includes(extension)) return javascript({ typescript: true, jsx: extension === "tsx" });
  if (["json", "jsonc"].includes(extension)) return json();
  if (["html", "htm"].includes(extension)) return html();
  if (extension === "css") return css();
  if (["md", "markdown"].includes(extension)) return markdown();
  if (extension === "py") return python();
  if (extension === "rs") return rust();
  if (extension === "java") return java();
  if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(extension)) return cpp();
  const shader = shaderLanguageFromExtension(extension);
  if (shader) return streamLanguages[shader];
  if (extension === "rb") return streamLanguages.ruby;
  if (extension === "go") return streamLanguages.go;
  if (["sh", "bash", "zsh"].includes(extension)) return streamLanguages.shell;
  return [];
}
