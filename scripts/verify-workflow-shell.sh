#!/usr/bin/env bash
# Syntax-check every bash `run:` block in .github/workflows with THIS bash.
#
# Why this exists: macOS ships bash 3.2, which happily parses constructs that
# the runners' bash 5 rejects. An inlined `$(node -p \"...\")` nested inside a
# double-quoted echo passed every local check and then died on the runner with
# `syntax error near unexpected token '('` -- in release.yml's finalize step,
# which only ever executes on a real tag. That failed the 1.2.0 release after
# both platform builds had already succeeded.
#
# Run this on a bash-5 host (CI ubuntu) to catch that class before a tag does.
#
# Scope: only blocks that actually run under bash. A step with no explicit
# `shell:` in a Windows job runs under pwsh, so those are skipped unless the
# job's `runs-on` is a literal ubuntu-*/macos-* image.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for wf in .github/workflows/*.yml; do
  ruby -ryaml -e '
    wf, out = ARGV
    # Psych 4 (newer rubies) disables aliases by default and needs the
    # keyword; Psych 3 (macOS system ruby 2.6) does not accept it at all.
    doc = begin
      YAML.load_file(wf, aliases: true)
    rescue ArgumentError
      YAML.load_file(wf)
    end
    (doc["jobs"] || {}).each do |job_name, job|
      next unless job.is_a?(Hash)
      runs_on = job["runs-on"].to_s
      # A literal Linux/macOS image defaults to bash; anything templated
      # (matrix) or Windows only counts with an explicit `shell: bash`.
      default_is_bash = runs_on.start_with?("ubuntu-", "macos-")
      (job["steps"] || []).each_with_index do |step, i|
        next unless step.is_a?(Hash) && step["run"]
        shell = step["shell"]
        runs_under_bash =
          if shell.nil? then default_is_bash
          else %w[bash sh].include?(shell)
          end
        next unless runs_under_bash
        slug = (step["name"] || "step#{i}").gsub(/[^A-Za-z0-9]+/, "_")[0, 60]
        base = File.basename(wf, ".yml")
        File.write(File.join(out, "#{base}##{job_name}##{i}_#{slug}.sh"), step["run"])
      end
    end
  ' "$wf" "$TMP"
done

checked=0
failed=0
for f in "$TMP"/*.sh; do
  [ -e "$f" ] || continue
  checked=$((checked + 1))
  if ! bash -n "$f" 2>"$TMP/stderr"; then
    echo "✗ shell syntax error in $(basename "$f" .sh)"
    sed 's/^/      /' "$TMP/stderr"
    failed=$((failed + 1))
  fi
done

echo "Checked $checked bash run block(s) with $(bash --version | head -1)"
if [ "$failed" -ne 0 ]; then
  echo "Error: $failed workflow run block(s) fail to parse."
  echo "       A run block that only executes on a tag or dispatch will not"
  echo "       surface this until it is far too late."
  exit 1
fi
echo "✓ every bash run block in .github/workflows parses"
