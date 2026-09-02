const shaderExtensions = {
  glsl: ["glsl", "vert", "frag", "geom", "tesc", "tese", "comp"],
  hlsl: ["hlsl", "fx", "fxh"],
} as const;

type ShaderLanguage = keyof typeof shaderExtensions;

export function shaderLanguageFromExtension(extension: string): ShaderLanguage | undefined {
  const normalized = extension.toLowerCase();
  for (const language of ["glsl", "hlsl"] as const) {
    if (shaderExtensions[language].some((candidate) => candidate === normalized)) return language;
  }
  return undefined;
}
