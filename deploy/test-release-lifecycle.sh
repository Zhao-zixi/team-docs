#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODE="${1:-}"
[[ "$MODE" == backup-failure || "$MODE" == health-failure ]] || { printf 'usage: %s backup-failure|health-failure\n' "$0" >&2; exit 2; }
TMP="$(mktemp -d)"
BACKUP_DIR="$HOME/.teamshelf-lifecycle-test-$$"
trap 'rm -rf -- "$TMP" "$BACKUP_DIR"' EXIT
mkdir -p "$TMP/bin"

cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env sh
exit 0
MOCK
cat >"$TMP/bin/jq" <<'MOCK'
#!/usr/bin/env sh
case "$*" in
  *'.services.teamshelf.image // empty'*) printf '%s\n' "$TEAMSHELF_IMAGE_REF" ;;
  *'.services.teamshelf.volumes'*) printf 'teamshelf-data\n' ;;
  *'.volumes["teamshelf-data"].name // empty'*) printf '%s\n' "$TEAMSHELF_DATA_VOLUME" ;;
  *'.volumes["teamshelf-data"].external // false'*) printf 'true\n' ;;
  *'.name // empty'*) printf '%s\n' "$TEAMSHELF_COMPOSE_PROJECT" ;;
  *) exit 2 ;;
esac
MOCK
cat >"$TMP/bin/docker-mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
if [[ "$1" == compose ]]; then
  case "$*" in
    *'config --format json'*) printf '{}\n'; exit 0 ;;
    *'config --quiet'*) exit 0 ;;
    *' stop teamshelf'*) printf 'compose-stop\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' start teamshelf'*) printf 'compose-start\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' up -d '*) printf 'compose-up\n' >>"$MOCK_EVENTS"; exit 0 ;;
    *' ps -q teamshelf'*) printf 'new-container\n'; exit 0 ;;
    *' logs '*) printf 'controlled test diagnostic\n'; exit 0 ;;
    *' ps -a'*) printf 'teamshelf state\n'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
case "$1" in
  ps) printf 'old-container\n'; exit 0 ;;
  inspect)
    case "$*" in
      *com.docker.compose.project*) printf '%s\n' "$TEAMSHELF_COMPOSE_PROJECT" ;;
      *com.docker.compose.service*) printf 'teamshelf\n' ;;
      *Destination*) printf '%s\n' "$TEAMSHELF_DATA_VOLUME" ;;
      *'.Image'*) printf 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' ;;
      *'.State.Health'*) printf 'unhealthy\n' ;;
      *'.State.Status'*new-container*) printf 'exited\n' ;;
      *'.State.Status'*) printf 'running\n' ;;
      *) exit 1 ;;
    esac
    ;;
  volume) exit 0 ;;
  pull) exit 0 ;;
  run)
    if [[ "$*" == *'fs.existsSync'* ]]; then printf 'yes'; exit 0; fi
    if [[ "$*" == *'backup.mjs'* ]]; then
      if [[ "$MODE" == backup-failure ]]; then exit 1; fi
      for arg in "$@"; do
        if [[ "$arg" == /backup/* ]]; then printf 'fake-backup' >"$MOCK_BACKUP_DIR/${arg##*/}"; fi
      done
      exit 0
    fi
    exit 0
    ;;
esac
exit 0
MOCK
chmod +x "$TMP/bin/"*

cat >"$TMP/.env" <<ENV
TEAMSHELF_COMPOSE_PROJECT=teamshelf-lifecycle
TEAMSHELF_DATA_VOLUME=teamshelf-lifecycle-data
TEAMSHELF_IMAGE_REF=ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TEAMSHELF_BACKUP_DIR=$BACKUP_DIR
APP_ORIGIN=http://127.0.0.1:8080
SETUP_TOKEN=lifecycle-test-only
ENV

export MODE
export PATH="$TMP/bin:$PATH"
export DOCKER_BIN="$TMP/bin/docker-mock"
export TEAMSHELF_ENV_FILE="$TMP/.env"
export TEAMSHELF_COMPOSE_PROJECT=teamshelf-lifecycle
export TEAMSHELF_DATA_VOLUME=teamshelf-lifecycle-data
export TEAMSHELF_IMAGE_REF=ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export TEAMSHELF_BACKUP_DIR="$BACKUP_DIR"
export MOCK_BACKUP_DIR="$BACKUP_DIR"
export MOCK_DOCKER_LOG="$TMP/docker.log"
export MOCK_EVENTS="$TMP/events"
: >"$MOCK_DOCKER_LOG"
: >"$MOCK_EVENTS"

if bash "$ROOT/deploy/release.sh" >"$TMP/run.out" 2>&1; then
  printf 'expected %s scenario to fail\n' "$MODE" >&2
  exit 1
fi
if [[ "$MODE" == backup-failure ]]; then
  grep -q 'backup failed' "$TMP/run.out"
  grep -q '^compose-stop$' "$MOCK_EVENTS"
  grep -q '^compose-start$' "$MOCK_EVENTS"
  ! grep -q '^compose-up$' "$MOCK_EVENTS"
else
  grep -q 'health check failed' "$TMP/run.out" || { cat "$TMP/run.out"; exit 1; }
  grep -q '^compose-up$' "$MOCK_EVENTS"
  [[ "$(grep -c '^compose-stop$' "$MOCK_EVENTS")" -eq 2 ]]
  ! grep -Eq 'restore.mjs|volume rm|down -v' "$MOCK_DOCKER_LOG"
  compgen -G "$BACKUP_DIR/deploy-failure-*.log" >/dev/null || { printf 'diagnostic file missing: %s\n' "$BACKUP_DIR"; ls -la "$BACKUP_DIR"; exit 1; }
  compgen -G "$BACKUP_DIR/teamshelf-*.sqlite" >/dev/null || { printf 'backup file missing: %s\n' "$BACKUP_DIR"; ls -la "$BACKUP_DIR"; exit 1; }
fi
printf 'release lifecycle mock passed: %s\n' "$MODE"
