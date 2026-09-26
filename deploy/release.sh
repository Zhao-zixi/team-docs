#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${TEAMSHELF_ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose.release.yaml"
DOCKER_BIN="${DOCKER_BIN:-docker}"
INIT_VOLUME=0

usage() {
  cat <<'USAGE'
Usage: bash deploy/release.sh [--init-volume]

Reads deployment settings from the repository-root .env. --init-volume permits
initializing a missing or verified-empty Docker volume; it never removes or
replaces a volume and is refused while a TeamShelf container exists.
USAGE
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  --init-volume) INIT_VOLUME=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; fail "unknown argument" ;;
esac

for command in bash awk realpath stat date jq; do
  command -v "$command" >/dev/null 2>&1 || fail "required command missing: $command"
done
command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail "Docker CLI not found"
[[ -f "$ENV_FILE" ]] || fail "local env file missing: $ENV_FILE (create it privately; never commit it)"
[[ -f "$COMPOSE_FILE" ]] || fail "release compose file missing"

# Parse literal dotenv assignments without sourcing the file or printing secrets.
read_env() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      count++
      value = substr($0, length(key) + 2)
      sub(/\r$/, "", value)
      if (length(value) >= 2 && substr(value,1,1) == "\"" && substr(value,length(value),1) == "\"") value=substr(value,2,length(value)-2)
      if (length(value) >= 2 && substr(value,1,1) == "\047" && substr(value,length(value),1) == "\047") value=substr(value,2,length(value)-2)
    }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE"
}

setting() { local key="$1"; local val="${!key:-}"; if [[ -n "$val" ]]; then printf '%s' "$val"; else read_env "$key"; fi; }
PROJECT="$(setting TEAMSHELF_COMPOSE_PROJECT)" || fail "provide TEAMSHELF_COMPOSE_PROJECT in environment or .env"
VOLUME="$(setting TEAMSHELF_DATA_VOLUME)" || fail "provide TEAMSHELF_DATA_VOLUME in environment or .env"
IMAGE_REF="${TEAMSHELF_IMAGE_REF:-}"; [[ -n "$IMAGE_REF" ]] || IMAGE_REF="$(read_env TEAMSHELF_IMAGE_REF)" || fail "provide TEAMSHELF_IMAGE_REF in workflow environment or .env"
BACKUP_DIR="$(setting TEAMSHELF_BACKUP_DIR)" || fail "provide TEAMSHELF_BACKUP_DIR in environment or .env"

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "invalid Compose project name"
[[ "$VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "invalid Docker volume name"
[[ "$IMAGE_REF" =~ ^ghcr\.io/zhao-zixi/team-docs@sha256:[a-f0-9]{64}$ ]] || fail "TEAMSHELF_IMAGE_REF must be ghcr.io/zhao-zixi/team-docs@sha256:<64 lowercase hex characters>"
[[ "$BACKUP_DIR" == /* ]] || fail "TEAMSHELF_BACKUP_DIR must be an absolute persistent NAS host path"
BACKUP_DIR_LEXICAL="$(realpath -m -s -- "$BACKUP_DIR")" || fail "could not normalize backup directory path"
BACKUP_DIR_RESOLVED="$(realpath -m -- "$BACKUP_DIR")" || fail "could not resolve backup directory path"
[[ "$BACKUP_DIR_LEXICAL" == "$BACKUP_DIR_RESOLVED" ]] || fail "backup directory path must not contain symbolic links"
BACKUP_DIR="$BACKUP_DIR_RESOLVED"
case "$BACKUP_DIR" in
  /tmp|/tmp/*|/var/tmp|/var/tmp/*) fail "backup directory must be persistent, not a temporary path" ;;
esac
case "$BACKUP_DIR" in
  "$ROOT"|"$ROOT"/*) fail "backup directory must be outside the repository/container checkout" ;;
esac

mkdir -p -- "$BACKUP_DIR"
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail "backup path must be a real persistent directory"
BACKUP_MODE="$(stat -c %a -- "$BACKUP_DIR")" || fail "could not inspect backup directory permissions"
BACKUP_OWNER="$(stat -c '%u:%g:%a' -- "$BACKUP_DIR")" || fail "could not inspect backup directory owner"
if [[ "$BACKUP_OWNER" != "$(id -u):1000:770" ]]; then (( (8#$BACKUP_MODE & 0022) == 0 || (8#$BACKUP_MODE & 01000) != 0 )) || fail "backup directory must be private or host-owned with container GID 1000 and mode 0770"; fi
# Atomic shared lock directory serializes separate checkouts using this deployment backup path.
LOCK_DIR="$BACKUP_DIR/.teamshelf-release-volume-$VOLUME.lock"
mkdir -m 700 -- "$LOCK_DIR" 2>/dev/null || fail "another deployment is running or a stale lock exists; inspect $LOCK_DIR and remove it only after verifying no deploy is active"
trap 'rmdir -- "$LOCK_DIR" 2>/dev/null || true' EXIT
COMPOSE=("$DOCKER_BIN" compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE")
"${COMPOSE[@]}" config --quiet >/dev/null || fail "Docker Compose release configuration is invalid; old service was not stopped"
CONFIG_JSON="$("${COMPOSE[@]}" config --format json 2>/dev/null)" || fail "could not resolve release Compose configuration"
CONFIG_PROJECT="$(jq -r '.name // empty' <<<"$CONFIG_JSON")"
CONFIG_IMAGE="$(jq -r '.services.teamshelf.image // empty' <<<"$CONFIG_JSON")"
CONFIG_VOLUME_SOURCE="$(jq -r '[.services.teamshelf.volumes[]? | select(.target == "/app/data" and .type == "volume")][0].source // empty' <<<"$CONFIG_JSON")"
CONFIG_VOLUME_NAME="$(jq -r '.volumes["teamshelf-data"].name // empty' <<<"$CONFIG_JSON")"
CONFIG_VOLUME_EXTERNAL="$(jq -r '.volumes["teamshelf-data"].external // false' <<<"$CONFIG_JSON")"
if [[ "$CONFIG_PROJECT" != "$PROJECT" || "$CONFIG_IMAGE" != "$IMAGE_REF" || "$CONFIG_VOLUME_SOURCE" != teamshelf-data || "$CONFIG_VOLUME_NAME" != "$VOLUME" || "$CONFIG_VOLUME_EXTERNAL" != true ]]; then
  fail "resolved Compose mismatch: project expected=$PROJECT actual=$CONFIG_PROJECT; image expected=$IMAGE_REF actual=$CONFIG_IMAGE; source expected=teamshelf-data actual=$CONFIG_VOLUME_SOURCE; external volume expected=$VOLUME actual=$CONFIG_VOLUME_NAME external=$CONFIG_VOLUME_EXTERNAL"
fi
unset CONFIG_JSON CONFIG_VOLUME_SOURCE CONFIG_VOLUME_NAME CONFIG_VOLUME_EXTERNAL

ALL_CONTAINER_IDS="$("$DOCKER_BIN" ps -aq --filter 'label=com.docker.compose.service=teamshelf')" || fail "could not enumerate TeamShelf containers; refusing deployment"
mapfile -t ALL_TEAMSHELF_CONTAINERS <<< "$ALL_CONTAINER_IDS"
PROJECT_CONTAINER_IDS="$("$DOCKER_BIN" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=teamshelf')" || fail "could not enumerate selected Compose project containers; refusing deployment"
mapfile -t PROJECT_CONTAINERS <<< "$PROJECT_CONTAINER_IDS"
for candidate in "${ALL_TEAMSHELF_CONTAINERS[@]}"; do
  [[ -n "$candidate" ]] || continue
  [[ "$candidate" == "${PROJECT_CONTAINERS[0]:-}" ]] || fail "another TeamShelf service container exists outside the selected Compose project; single-instance deployment refused"
done
(( ${#PROJECT_CONTAINERS[@]} <= 1 )) || fail "multiple TeamShelf containers exist for project $PROJECT; resolve duplicates manually"
OLD_CONTAINER="${PROJECT_CONTAINERS[0]:-}"
OLD_IMAGE=""
OLD_RUNNING=0
if [[ -n "$OLD_CONTAINER" ]]; then
  LABEL_PROJECT="$("$DOCKER_BIN" inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$OLD_CONTAINER")"
  LABEL_SERVICE="$("$DOCKER_BIN" inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$OLD_CONTAINER")"
  OLD_VOLUME="$("$DOCKER_BIN" inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$OLD_CONTAINER")"
  [[ "$LABEL_PROJECT" == "$PROJECT" && "$LABEL_SERVICE" == teamshelf ]] || fail "existing container labels do not match selected project/service"
  [[ "$OLD_VOLUME" == "$VOLUME" ]] || fail "existing container uses volume '$OLD_VOLUME', not configured '$VOLUME'; deployment refused to switch databases"
  OLD_IMAGE="$("$DOCKER_BIN" inspect -f '{{.Image}}' "$OLD_CONTAINER")"
  OLD_STATE="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$OLD_CONTAINER")"
  [[ "$OLD_STATE" == running ]] && OLD_RUNNING=1
fi

if "$DOCKER_BIN" volume inspect "$VOLUME" >/dev/null 2>&1; then
  VOLUME_EXISTS=1
else
  VOLUME_EXISTS=0
fi
if (( ! VOLUME_EXISTS && ! INIT_VOLUME )); then
  fail "Docker volume '$VOLUME' does not exist; first initialization requires --init-volume"
fi

if (( VOLUME_EXISTS )); then
  VOLUME_CONTAINER_IDS="$("$DOCKER_BIN" ps -aq --filter "volume=$VOLUME")" || fail "could not enumerate volume users; refusing deployment"
  mapfile -t VOLUME_CONTAINERS <<< "$VOLUME_CONTAINER_IDS"
  for container in "${VOLUME_CONTAINERS[@]}"; do
    [[ -n "$container" ]] || continue
    [[ "$container" == "$OLD_CONTAINER" ]] || fail "data volume is attached to another container; inspect it manually before deployment"
  done
fi


# Pull while the old instance is still serving.
"$DOCKER_BIN" pull "$IMAGE_REF" >/dev/null || fail "image pull failed; current service was not stopped"

if (( ! VOLUME_EXISTS )); then
  (( INIT_VOLUME )) || fail "volume disappeared during preflight"
  "$DOCKER_BIN" volume create "$VOLUME" >/dev/null || fail "could not create explicitly requested first-use volume"
  VOLUME_EXISTS=1
fi

DB_EXISTS="$("$DOCKER_BIN" run --rm --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node "$IMAGE_REF" -e "import('node:fs').then(fs=>process.stdout.write(fs.existsSync('/app/data/teamshelf.sqlite')?'yes':'no'))")" || fail "could not inspect selected data volume"
if [[ "$DB_EXISTS" != yes ]]; then
  EMPTY_DIR="$("$DOCKER_BIN" run --rm --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node "$IMAGE_REF" -e "import('node:fs').then(fs=>process.stdout.write(fs.readdirSync('/app/data').length?'no':'yes'))")" || fail "could not inspect selected data volume contents"
  [[ "$EMPTY_DIR" == yes && "$INIT_VOLUME" == 1 && -z "$OLD_CONTAINER" ]] || fail "selected volume has no database and is not an explicitly authorized empty first install"
  "$DOCKER_BIN" run --rm --user 0:0 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node "$IMAGE_REF" -e "import('node:fs/promises').then(fs=>fs.chown('/app/data',1000,1000))" || fail "could not prepare explicitly initialized volume ownership"
  "$DOCKER_BIN" run --rm --user 1000:1000 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node "$IMAGE_REF" -e "import('node:fs/promises').then(fs=>fs.access('/app/data',3))" || fail "initialized volume is not writable by the non-root app user"
else
  "$DOCKER_BIN" run --rm --user 1000:1000 --mount "type=volume,src=$VOLUME,dst=/app/data" --entrypoint node "$IMAGE_REF" -e "import('node:fs/promises').then(fs=>fs.access('/app/data',3))" || fail "selected volume is not writable by the non-root app user"
fi

PROBE_NAME=".teamshelf-write-probe-$$"
"$DOCKER_BIN" run --rm --user 1000:1000 --mount "type=bind,src=$BACKUP_DIR,dst=/backup" --entrypoint node "$IMAGE_REF" -e "import('node:fs/promises').then(async fs=>{const p='/backup/$PROBE_NAME';await fs.writeFile(p,'ok',{flag:'wx'});await fs.unlink(p)})" || fail "backup path is not writable through Docker bind mount; old service was not stopped"

if [[ -n "$OLD_CONTAINER" && "$OLD_RUNNING" == 1 ]]; then
  "${COMPOSE[@]}" stop teamshelf >/dev/null || fail "old service did not stop cleanly; no backup or replacement attempted"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_FILE="$BACKUP_DIR/teamshelf-$STAMP.sqlite"
BACKUP_IMAGE="${OLD_IMAGE:-$IMAGE_REF}"
if [[ "$DB_EXISTS" == yes ]]; then
  if ! "$DOCKER_BIN" run --rm --network none --user 1000:1000 --mount "type=volume,src=$VOLUME,dst=/app/data" --mount "type=bind,src=$BACKUP_DIR,dst=/backup" -e DATA_DIR=/app/data --entrypoint node "$BACKUP_IMAGE" /app/scripts/backup.mjs "/backup/teamshelf-$STAMP.sqlite" >/dev/null; then
    printf 'ERROR: consistent backup failed; replacement image was not started.\n' >&2
    if [[ -n "$OLD_CONTAINER" && "$OLD_RUNNING" == 1 ]]; then
      "${COMPOSE[@]}" start teamshelf >/dev/null || printf 'WARNING: old service did not restart; inspect Docker state and start the existing container after review.\n' >&2
    fi
    fail "backup failed; database and old image remain intact. Inspect backup path/service status, then retry"
  fi
  if [[ ! -s "$BACKUP_FILE" ]]; then
    if [[ -n "$OLD_CONTAINER" && "$OLD_RUNNING" == 1 ]]; then "${COMPOSE[@]}" start teamshelf >/dev/null || true; fi
    fail "backup command returned success but no persistent backup file exists; old service restart was attempted"
  fi
  printf 'Consistent backup saved: %s\n' "$BACKUP_FILE"
else
  printf 'First initialization: no existing database; explicit --init-volume authorization accepted.\n'
fi

if ! "${COMPOSE[@]}" up -d --force-recreate --no-deps teamshelf >/dev/null; then
  fail "replacement container could not start. Database was not restored/downgraded; inspect Docker state and preserve prior image $BACKUP_IMAGE"
fi

HEALTH_DEADLINE=$((SECONDS + 180))
while (( SECONDS < HEALTH_DEADLINE )); do
  NEW_CONTAINER="$("${COMPOSE[@]}" ps -q teamshelf 2>/dev/null || true)"
  if [[ -n "$NEW_CONTAINER" ]]; then
    HEALTH="$("$DOCKER_BIN" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$NEW_CONTAINER" 2>/dev/null || true)"
    [[ "$HEALTH" == healthy ]] && { printf 'TeamShelf release healthy: %s\n' "$IMAGE_REF"; exit 0; }
    STATE="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$NEW_CONTAINER" 2>/dev/null || true)"
    if [[ "$STATE" == exited || "$STATE" == dead ]]; then break; fi
  fi
  sleep 3
done

DIAG_FILE="$BACKUP_DIR/deploy-failure-$STAMP.log"
: > "$DIAG_FILE"
chmod 600 "$DIAG_FILE"
"${COMPOSE[@]}" ps -a >>"$DIAG_FILE" 2>&1 || true
"${COMPOSE[@]}" logs --no-color --tail=200 teamshelf >>"$DIAG_FILE" 2>&1 || true
"${COMPOSE[@]}" stop teamshelf >/dev/null 2>&1 || true
printf 'ERROR: health check failed. New service stopped; no DB restore, schema downgrade, volume deletion, or automatic rollback attempted.\n' >&2
printf 'Diagnostics: %s\n' "$DIAG_FILE" >&2
printf 'Recovery: inspect diagnostics and DB compatibility; preserve this backup and prior image %s. Restore only through an operator-approved procedure.\n' "$BACKUP_IMAGE" >&2
exit 1
