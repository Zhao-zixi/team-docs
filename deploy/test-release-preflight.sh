#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
BACKUP_DIR="$HOME/.teamshelf-preflight-$$"
trap 'rm -rf -- "$TMP" "$BACKUP_DIR"' EXIT
mkdir -p "$TMP/bin" "$TMP/backup"

cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env sh
exit 0
MOCK
cat >"$TMP/bin/realpath" <<'MOCK'
#!/usr/bin/env bash
args="$*"
path="${!#}"
case "$path" in
  */backup-link)
    if [[ " $args " == *" -s "* ]]; then printf '%s\n' "$path"; else printf '%s\n' "${path%/backup-link}/real-backup"; fi
    ;;
  */backup-link/sub)
    if [[ " $args " == *" -s "* ]]; then printf '%s\n' "$path"; else printf '%s\n' "${path%/backup-link/sub}/real-backup/sub"; fi
    ;;
  *) exec /usr/bin/realpath "$@" ;;
esac
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
    *) exit 0 ;;
  esac
fi
case "$1" in
  ps) if [[ "${MOCK_FAIL_PS:-0}" == 1 ]]; then exit 2; fi; if [[ "${MOCK_OLD_CONTAINER:-0}" == 1 && "$*" == *"label=com.docker.compose.service=teamshelf"* ]]; then printf 'old-container\n'; exit 0; fi; if [[ "${MOCK_VOLUME_ATTACHED:-0}" == 1 && "$*" == *"volume="* ]]; then printf 'unrelated-container\n'; exit 0; fi; exit 0 ;;
  inspect)
    case "$*" in
      *com.docker.compose.project*) printf 'teamshelf-existing\n' ;;
      *com.docker.compose.service*) printf 'teamshelf\n' ;;
      *Destination*) printf 'wrong-volume\n' ;;
      *) exit 1 ;;
    esac
    ;;
  volume)
    [[ "$2" == inspect && "${MOCK_VOLUME_EXISTS:-0}" == 1 ]] && exit 0
    [[ "$2" == inspect ]] && exit 1
    exit 0
    ;;
esac
exit 0
MOCK
cat >"$TMP/bin/stat" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *"-c %u:%g:%a"*) if [[ -n "$MOCK_BACKUP_OWNER" ]]; then printf '%s\n' "$MOCK_BACKUP_OWNER"; exit 0; fi ;;
  *"-c %a"*) if [[ -n "$MOCK_BACKUP_MODE" ]]; then printf '%s\n' "$MOCK_BACKUP_MODE"; exit 0; fi ;;
esac
exec /usr/bin/stat "$@"
MOCK
chmod +x "$TMP/bin/"*

cat >"$TMP/.env" <<ENV
TEAMSHELF_COMPOSE_PROJECT=teamshelf-existing
TEAMSHELF_DATA_VOLUME=teamshelf-existing_teamshelf-data
TEAMSHELF_IMAGE_REF=ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TEAMSHELF_BACKUP_DIR=$BACKUP_DIR
APP_ORIGIN=http://localhost:8080
SETUP_TOKEN=test-only-secret-value
ENV

export PATH="$TMP/bin:$PATH"
export DOCKER_BIN="$TMP/bin/docker-mock"
export TEAMSHELF_ENV_FILE="$TMP/.env"
export TEAMSHELF_COMPOSE_PROJECT=teamshelf-existing
export TEAMSHELF_DATA_VOLUME=teamshelf-existing_teamshelf-data
export TEAMSHELF_BACKUP_DIR="$BACKUP_DIR"

export MOCK_DOCKER_LOG="$TMP/docker.log"

# Workflow input must be rejected before invoking Docker, and no secret may echo.
export TEAMSHELF_IMAGE_REF=not-a-digest
if bash "$ROOT/deploy/release.sh" >"$TMP/invalid.out" 2>&1; then
  printf 'expected invalid digest to fail\n' >&2
  exit 1
fi
grep -q 'sha256:' "$TMP/invalid.out"
! grep -q 'test-only-secret-value' "$TMP/invalid.out"
[[ ! -s "$MOCK_DOCKER_LOG" ]]

# The shared volume lock rejects active directories and symlink redirection before Docker calls.
export TEAMSHELF_IMAGE_REF=ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mkdir -p "$BACKUP_DIR"
LOCK_DIR="$BACKUP_DIR/.teamshelf-release-volume-$TEAMSHELF_DATA_VOLUME.lock"
printf 'leave-this-file-alone' >"$TMP/lock-target"
if ln -s "$TMP/lock-target" "$LOCK_DIR" 2>/dev/null; then
  : >"$MOCK_DOCKER_LOG"
  if bash "$ROOT/deploy/release.sh" >"$TMP/lock-link.out" 2>&1; then printf 'expected symlink lock rejection\n' >&2; exit 1; fi
  grep -q 'another deployment is running or a stale lock exists' "$TMP/lock-link.out"
  [[ -L "$LOCK_DIR" ]] && [[ "$(cat "$TMP/lock-target")" == leave-this-file-alone ]]
  [[ ! -s "$MOCK_DOCKER_LOG" ]]
  rm -- "$LOCK_DIR"
else
  mkdir -m 700 "$LOCK_DIR"
  : >"$MOCK_DOCKER_LOG"
  if bash "$ROOT/deploy/release.sh" >"$TMP/lock-exists.out" 2>&1; then printf 'expected active lock rejection\n' >&2; exit 1; fi
  grep -q 'another deployment is running or a stale lock exists' "$TMP/lock-exists.out"
  [[ ! -s "$MOCK_DOCKER_LOG" ]]
  rmdir "$LOCK_DIR"
fi

# Backup directory symlinks are rejected both at the final component and in parents.
mkdir -p "$TMP/real-backup/sub"
ln -s "$TMP/real-backup" "$TMP/backup-link"
for path in "$TMP/backup-link" "$TMP/backup-link/sub"; do
  export TEAMSHELF_BACKUP_DIR="$path"
  : >"$MOCK_DOCKER_LOG"
  if bash "$ROOT/deploy/release.sh" >"$TMP/backup-symlink.out" 2>&1; then
    printf 'expected backup path symlink to be rejected: %s\n' "$path" >&2
    exit 1
  fi
  grep -q 'backup directory path must not contain symbolic links' "$TMP/backup-symlink.out"
  [[ ! -s "$MOCK_DOCKER_LOG" ]]
done
export TEAMSHELF_BACKUP_DIR="$BACKUP_DIR"

# Only a host-owned directory with the image's exact GID and 0770 mode may be group-writable.
export MOCK_BACKUP_MODE=777 MOCK_BACKUP_OWNER="$(id -u):1000:777"
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/insecure-mode.out" 2>&1; then
  printf 'expected unsafe group/world writable backup directory to fail\n' >&2
  exit 1
fi
grep -q 'backup directory must be private or host-owned' "$TMP/insecure-mode.out"
[[ ! -s "$MOCK_DOCKER_LOG" ]]
export MOCK_BACKUP_MODE=770 MOCK_BACKUP_OWNER="$(id -u):1000:770"
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/container-group-mode.out" 2>&1; then
  printf 'expected later missing-volume preflight to fail\n' >&2
  exit 1
fi
grep -q 'does not exist' "$TMP/container-group-mode.out"
! grep -q 'backup directory must be' "$TMP/container-group-mode.out"
unset MOCK_BACKUP_MODE MOCK_BACKUP_OWNER
# A missing external volume must fail before pull, stop, or any service mutation.
export TEAMSHELF_IMAGE_REF=ghcr.io/zhao-zixi/team-docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/missing-volume.out" 2>&1; then
  printf 'expected missing volume to fail\n' >&2
  exit 1
fi
grep -q "does not exist" "$TMP/missing-volume.out"
! grep -Eq 'pull | stop | up ' "$MOCK_DOCKER_LOG"
! grep -q 'test-only-secret-value' "$TMP/missing-volume.out"

# Docker daemon/listing errors must fail closed before any release mutation.
export MOCK_FAIL_PS=1
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/docker-list-failure.out" 2>&1; then
  printf 'expected docker ps failure to fail closed\n' >&2
  exit 1
fi
grep -q 'could not enumerate TeamShelf containers' "$TMP/docker-list-failure.out"
! grep -Eq 'pull | stop | up ' "$MOCK_DOCKER_LOG"
unset MOCK_FAIL_PS

# A different container holding the configured database volume blocks deployment.
export MOCK_VOLUME_EXISTS=1
export MOCK_VOLUME_ATTACHED=1
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/volume-in-use.out" 2>&1; then
  printf 'expected an external volume user to block deployment\n' >&2
  exit 1
fi
grep -q 'data volume is attached to another container' "$TMP/volume-in-use.out"
! grep -Eq 'pull | stop | up ' "$MOCK_DOCKER_LOG"
unset MOCK_VOLUME_EXISTS MOCK_VOLUME_ATTACHED

# A current TeamShelf container with a different data-volume mount is never replaced.
export MOCK_OLD_CONTAINER=1
: >"$MOCK_DOCKER_LOG"
if bash "$ROOT/deploy/release.sh" >"$TMP/mismatched-volume.out" 2>&1; then
  printf 'expected a mismatched existing mount to fail closed\n' >&2
  exit 1
fi
grep -q 'uses volume' "$TMP/mismatched-volume.out"
! grep -Eq 'pull | stop | up ' "$MOCK_DOCKER_LOG"
unset MOCK_OLD_CONTAINER
printf 'release preflight mock checks passed (invalid digest, missing volume, no early mutation, no secret output)\n'
