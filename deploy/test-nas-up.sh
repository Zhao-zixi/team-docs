#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
TEST_ROOT="$TMP/nas project with spaces"
mkdir -p "$TEST_ROOT/deploy" "$TMP/bin"
cp "$ROOT/deploy/nas-up.sh" "$TEST_ROOT/deploy/nas-up.sh"
cat >"$TMP/bin/docker-mock" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_LOG"
if [[ "$1" == compose && "$2" == version ]]; then exit 0; fi
exit 0
MOCK
cat >"$TMP/bin/jq" <<'MOCK'
#!/usr/bin/env sh
exit 0
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" DOCKER_BIN="$TMP/bin/docker-mock" MOCK_LOG="$TMP/docker.log"
: >"$MOCK_LOG"

bash "$TEST_ROOT/deploy/nas-up.sh" --help >"$TMP/help.out"
grep -q 'Node 24 in Docker' "$TMP/help.out"
if bash "$TEST_ROOT/deploy/nas-up.sh" --bogus >"$TMP/unknown.out" 2>&1; then echo 'expected unknown option failure' >&2; exit 1; fi
grep -q 'unknown argument' "$TMP/unknown.out"
IMAGE='ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
BACKUP="$HOME/.teamshelf-nas-wrapper-test-$$"
if bash "$TEST_ROOT/deploy/nas-up.sh" --project nas-test --volume nas-test-data --backup-dir "$BACKUP" --origin http://localhost:8080 --image-ref invalid >"$TMP/digest.out" 2>&1; then echo 'expected invalid digest rejection' >&2; exit 1; fi
grep -q 'immutable sha256 digest' "$TMP/digest.out"
[[ ! -e "$TEST_ROOT/.env" && ! -e "$BACKUP" ]]
if bash "$TEST_ROOT/deploy/nas-up.sh" --project nas-test --volume nas-test-data --backup-dir "$BACKUP" --origin http://localhost:8080/path --image-ref "$IMAGE" >"$TMP/origin.out" 2>&1; then echo 'expected non-origin URL rejection' >&2; exit 1; fi
grep -q 'exact http(s) origin' "$TMP/origin.out"
[[ ! -e "$TEST_ROOT/.env" && ! -e "$BACKUP" ]]
if bash "$TEST_ROOT/deploy/nas-up.sh" --project nas-test --volume nas-test-data --backup-dir "$BACKUP" --origin http://localhost:8080 --image-ref "$IMAGE" >"$TMP/platform.out" 2>&1; then echo 'expected Linux-only NAS launcher gate' >&2; exit 1; fi
grep -q 'run this NAS launcher in Linux' "$TMP/platform.out"
[[ ! -e "$TEST_ROOT/.env" && ! -e "$BACKUP" ]]
# Static rejection must not start config generation, pull or deployment commands.
! grep -Eq ' run |pull|stop|up ' "$MOCK_LOG"
printf 'nas-up mock passed: help, unknown option, invalid digest/origin, platform guard, no config or volume mutation\n'
