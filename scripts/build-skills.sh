#!/usr/bin/env bash
# build-skills.sh — populate dist/skills/<slug>/SKILL.md from the
# InsForge/insforge-skills repo. Idempotent. Intended to run as part of
# `prepublishOnly` before `npm publish`, so that published tarballs contain
# the bundled skill markdown files alongside the compiled CLI.
#
# Usage:
#   ./scripts/build-skills.sh                # clone default repo + branch
#   INSFORGE_SKILLS_REPO=... SKILLS_REF=...  # override source
#   INSFORGE_SKILLS_LOCAL_DIR=/path/to/repo  # use a local checkout (no clone)
#
# The script is deliberately bash + git, no JS deps — keeps `npm run build`
# fast and cheap. It skips silently with a warning if `git` isn't on PATH so
# local dev builds don't fail without network.
set -euo pipefail

repo="${INSFORGE_SKILLS_REPO:-https://github.com/InsForge/insforge-skills.git}"
ref="${SKILLS_REF:-main}"
out_dir="${SKILLS_OUT_DIR:-dist/skills}"
local_dir="${INSFORGE_SKILLS_LOCAL_DIR:-}"

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

mkdir -p "$out_dir"

if [ -n "$local_dir" ]; then
  src="$local_dir"
  cleanup=""
else
  if ! command -v git >/dev/null 2>&1; then
    echo "build-skills: warning — git not on PATH; leaving $out_dir empty. Install skills from npm or run \`git\` locally." >&2
    exit 0
  fi
  tmp="$(mktemp -d -t insforge-skills-XXXXXX)"
  cleanup="$tmp"
  # Shallow clone to keep the build fast. If the network is unreachable, fail
  # loudly — we don't want to ship an empty bundle to npm silently.
  git clone --depth 1 --branch "$ref" "$repo" "$tmp" >/dev/null 2>&1 || {
    echo "build-skills: error — could not clone $repo@$ref" >&2
    rm -rf "$tmp"
    exit 1
  }
  src="$tmp"
fi

trap '[ -n "${cleanup:-}" ] && rm -rf "${cleanup}"' EXIT

copied=0
# Prefer `skill-*/SKILL.md` directories (canonical layout in
# InsForge/insforge-skills). Fall back to `*/SKILL.md` if the repo layout
# changes, so the build doesn't silently ship nothing.
shopt -s nullglob
for skill_dir in "$src"/skill-*/; do
  slug="$(basename "$skill_dir")"
  slug="${slug#skill-}"
  if [ -f "$skill_dir/SKILL.md" ]; then
    mkdir -p "$out_dir/$slug"
    cp "$skill_dir/SKILL.md" "$out_dir/$slug/SKILL.md"
    chmod 0644 "$out_dir/$slug/SKILL.md"
    copied=$((copied + 1))
  fi
done

if [ "$copied" -eq 0 ]; then
  for skill_dir in "$src"/*/; do
    [ "$(basename "$skill_dir")" = "node_modules" ] && continue
    [ "$(basename "$skill_dir")" = ".git" ] && continue
    slug="$(basename "$skill_dir")"
    if [ -f "$skill_dir/SKILL.md" ]; then
      mkdir -p "$out_dir/$slug"
      cp "$skill_dir/SKILL.md" "$out_dir/$slug/SKILL.md"
      chmod 0644 "$out_dir/$slug/SKILL.md"
      copied=$((copied + 1))
    fi
  done
fi

if [ "$copied" -eq 0 ]; then
  echo "build-skills: warning — no skills found in $src" >&2
else
  echo "build-skills: copied $copied skill(s) into $out_dir"
fi
