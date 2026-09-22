import { StreamLanguage } from "@codemirror/language";
import { clike, shader as glsl } from "@codemirror/legacy-modes/mode/clike";
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


export function shaderLanguage(name: string) { return StreamLanguage.define(name === "hlsl" ? hlsl : glsl); }
