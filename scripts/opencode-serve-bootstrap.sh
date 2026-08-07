#!/usr/bin/env bash
set -euo pipefail
export PATH="${HOME}/.opencode/bin:${PATH}"
if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash
  export PATH="${HOME}/.opencode/bin:${PATH}"
fi
exec opencode serve --hostname 0.0.0.0 --port 4096
