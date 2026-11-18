#!/usr/bin/env bash
# Assert that the toolchain on PATH is the one this repo pins, and record it in
# the build log. A job that silently floats to a newer compiler produces results
# that differ from the gating jobs for no code reason.
#
# Usage: scripts/check-toolchain.sh rust|foundry|all
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_rust() {
  local pinned actual
  pinned="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$REPO_ROOT/rust-toolchain.toml")"
  if [ -z "$pinned" ]; then
    echo "error: no channel found in rust-toolchain.toml" >&2
    exit 1
  fi

  actual="$(rustc --version)"
  echo "rustc: $actual"
  echo "cargo: $(cargo --version)"
  echo "pinned (rust-toolchain.toml): $pinned"

  # rust-toolchain.toml only takes effect when rustup runs inside the repo, so
  # this check is the only thing that proves it did.
  if ! grep -q " $pinned " <<<"$actual "; then
    echo "error: rustc is not the pinned toolchain $pinned" >&2
    exit 1
  fi
  echo "✔ rust toolchain matches rust-toolchain.toml"

  # The workspace MSRV drives the MSRV-aware resolver; if it drifts from the
  # pin, lock updates can select crates the pinned compiler cannot build.
  local msrv
  msrv="$(sed -n 's/^rust-version = "\(.*\)"/\1/p' "$REPO_ROOT/contracts/soroban/Cargo.toml")"
  echo "workspace rust-version (contracts/soroban/Cargo.toml): ${msrv:-<unset>}"
  if [ -z "$msrv" ] || [[ "$pinned" != "$msrv" && "$pinned" != "$msrv".* ]]; then
    echo "error: workspace rust-version '$msrv' does not match pinned toolchain $pinned" >&2
    exit 1
  fi
  echo "✔ workspace rust-version matches rust-toolchain.toml"
}

check_foundry() {
  echo "forge: $(forge --version | head -1)"

  # FOUNDRY_VERSION is set at workflow level; locally it is usually unset, in
  # which case the version is recorded but not enforced.
  if [ -z "${FOUNDRY_VERSION:-}" ]; then
    echo "⏭ FOUNDRY_VERSION unset — recording version only"
    return 0
  fi

  echo "pinned (FOUNDRY_VERSION): $FOUNDRY_VERSION"

  # Normalise the pin to a bare semantic version: drop a leading "v" and any
  # "nightly-" prefix. A moving channel such as "stable" cannot be verified, so
  # it is rejected rather than silently accepted.
  local pinned="${FOUNDRY_VERSION#nightly-}"
  pinned="${pinned#v}"
  if ! [[ "$pinned" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: FOUNDRY_VERSION '$FOUNDRY_VERSION' is not an exact release version" >&2
    exit 1
  fi

  # The local docker-compose Anvil image must use the same Foundry version.
  local compose_file
  compose_file="$(dirname "${BASH_SOURCE[0]}")/../docker-compose.yml"
  if [ -f "$compose_file" ]; then
    local compose_tag
    compose_tag="$(grep -oE 'foundry-rs/foundry:[^[:space:]"@]+' "$compose_file" | head -1 | cut -d: -f2 || true)"
    compose_tag="${compose_tag#nightly-}"
    compose_tag="${compose_tag#v}"
    if [ "$compose_tag" != "$pinned" ]; then
      echo "error: docker-compose.yml Foundry image '$compose_tag' differs from pinned version $pinned" >&2
      exit 1
    fi
    echo "✔ docker-compose.yml Foundry image matches FOUNDRY_VERSION"
  fi

  # forge --version prints e.g. "forge 1.2.3 (abcdefg 2024-01-01T00:00:00Z)".
  local actual
  actual="$(forge --version | head -1 | awk '{print $2}')"
  actual="${actual#v}"
  echo "actual (forge --version): $actual"

  if [ "$actual" != "$pinned" ]; then
    echo "error: forge $actual is not the pinned version $pinned" >&2
    exit 1
  fi
  echo "✔ forge matches FOUNDRY_VERSION"
}

case "${1:-all}" in
  rust) check_rust ;;
  foundry) check_foundry ;;
  all) check_rust; check_foundry ;;
  *) echo "usage: $0 rust|foundry|all" >&2; exit 2 ;;
esac
