import { escapeHtml } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { repository } from "./constants.ts";
import type { HttpFetcher } from "./http.ts";

const compareResponseSchema = Type.Object({
  files: Type.Array(Type.Object({
    filename: Type.String(),
    status: Type.String(),
  })),
});

export type CompareFile = Static<typeof compareResponseSchema>["files"][number];
export interface ReleaseNoteEntry { filename: string; html: string }

export function releaseNoteFilenames(files: CompareFile[]): string[] {
  return files
    .filter((file) => file.status === "added" && file.filename.startsWith("release_notes/") && file.filename.endsWith(".md"))
    .map((file) => file.filename)
    .sort((a, b) => a.localeCompare(b));
}

function rawUrl(sha: string, filename: string): string {
  return `https://raw.githubusercontent.com/${repository}/${sha}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

function resolveRelativeMedia(markdownFilename: string, sha: string, value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return value;
  const directory = markdownFilename.split("/").slice(0, -1).join("/");
  const normalized = new URL(value, `https://raw.githubusercontent.com/${repository}/${sha}/${directory}/`).toString();
  return normalized;
}

function inlineMarkdown(text: string, markdownFilename: string, sha: string): string {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, href: string) => {
    const src = resolveRelativeMedia(markdownFilename, sha, href.trim());
    if (!/^https?:\/\//i.test(src)) return alt;
    const safeSrc = escapeHtml(src);
    const safeAlt = escapeHtml(alt);
    return /\.(mp4|webm|mov)(\?|#|$)/i.test(src)
      ? `<video controls playsinline src="${safeSrc}" title="${safeAlt}"></video>`
      : `<img src="${safeSrc}" alt="${safeAlt}">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const target = resolveRelativeMedia(markdownFilename, sha, href.trim());
    return /^https?:\/\//i.test(target) ? `<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${label}</a>` : label;
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

export function renderMarkdown(markdown: string, markdownFilename: string, sha: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;
  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${inlineMarkdown(paragraph.join(" "), markdownFilename, sha)}</p>`;
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      html += `<ul>${list.map((item) => `<li>${inlineMarkdown(item, markdownFilename, sha)}</li>`).join("")}</ul>`;
      list = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) {
        html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
        code = undefined;
      } else {
        flushParagraph(); flushList(); code = [];
      }
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); html += `<h${heading[1].length}>${inlineMarkdown(heading[2], markdownFilename, sha)}</h${heading[1].length}>`; continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  if (code) html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
  return html;
}

export async function fetchReleaseNotes(currentSha: string | undefined, stableSha: string | undefined, fetcher: HttpFetcher = fetch): Promise<string> {
  if (!currentSha || !stableSha) return `<p>What’s new is unavailable for this update because the current image does not include revision metadata.</p>`;
  const compare = await fetcher(`https://api.github.com/repos/${repository}/compare/${encodeURIComponent(currentSha)}...${encodeURIComponent(stableSha)}`, { headers: { accept: "application/vnd.github+json" } });
  if (!compare.ok) throw new Error(`GitHub compare request failed: ${compare.status}`);
  const { files } = Value.Parse(compareResponseSchema, await compare.json());
  const filenames = releaseNoteFilenames(files);
  if (filenames.length === 0) return `<p>No release notes were published for this update.</p>`;
  const entries: ReleaseNoteEntry[] = [];
  for (const filename of filenames) {
    const response = await fetcher(rawUrl(stableSha, filename));
    if (!response.ok) throw new Error(`release note fetch failed for ${filename}: ${response.status}`);
    entries.push({ filename, html: renderMarkdown(await response.text(), filename, stableSha) });
  }
  return `<section id="whats-new" class="update-release-notes">${entries.map((entry) => `<article class="update-note">${entry.html}</article>`).join("")}</section>`;
}
