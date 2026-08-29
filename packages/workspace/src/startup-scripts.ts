import { shellQuote } from "@atelier/core";

export function seedConfigInstallScript(source: string, target: string): string {
  return `seed_src=${shellQuote(source)}; seed_dst=${shellQuote(target)}
if [ -f "$seed_src" ]; then
  seed_dir="$(dirname "$seed_dst")"
  su atelier -s /bin/sh -c 'mkdir -p "$1"' sh "$seed_dir"
  install -o atelier -g atelier -m 600 "$seed_src" "$seed_dst"
  rm -f "$seed_src"
elif [ -f "$seed_dst" ]; then
  :
else
  echo "workspace seed is missing from both $seed_src and $seed_dst" >&2
  exit 1
fi`;
}
