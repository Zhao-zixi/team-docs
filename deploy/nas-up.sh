#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$ROOT/.env"
DOCKER_BIN="${DOCKER_BIN:-docker}"
INIT_VOLUME=0
ARG_PROJECT="" ARG_VOLUME="" ARG_BACKUP_DIR="" ARG_ORIGIN="" ARG_IMAGE_REF="" ARG_PORT="" ARG_COOKIE_SECURE=""
usage() {
  cat <<'USAGE'
Usage: bash deploy/nas-up.sh --project NAME --volume EXACT_NAME --backup-dir ABSOLUTE_PATH --image-ref ghcr.io/zhao-zixi/team-docs@sha256:<64hex> [--origin URL] [--port PORT] [--cookie-secure true|false] [--init-volume]

First use requires --origin and --init-volume only when creating a missing empty volume.
The launcher creates .env once with a random setup token using Node 24 in Docker; it
never overwrites an existing .env. Existing project, volume and backup settings must
match exactly. Log in to the private GHCR package once with `docker login ghcr.io`.
The existing release.sh performs the immutable-digest pull, backup, deployment and health check.
USAGE
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --project) (($# >= 2)) || fail '--project requires a value'; ARG_PROJECT="$2"; shift 2 ;;
    --volume) (($# >= 2)) || fail '--volume requires a value'; ARG_VOLUME="$2"; shift 2 ;;
    --backup-dir) (($# >= 2)) || fail '--backup-dir requires a value'; ARG_BACKUP_DIR="$2"; shift 2 ;;
    --origin) (($# >= 2)) || fail '--origin requires a value'; ARG_ORIGIN="$2"; shift 2 ;;
    --image-ref) (($# >= 2)) || fail '--image-ref requires a value'; ARG_IMAGE_REF="$2"; shift 2 ;;
    --port) (($# >= 2)) || fail '--port requires a value'; ARG_PORT="$2"; shift 2 ;;
    --cookie-secure) (($# >= 2)) || fail '--cookie-secure requires true or false'; ARG_COOKIE_SECURE="$2"; shift 2 ;;
    --init-volume) INIT_VOLUME=1; shift ;;
    *) usage >&2; fail 'unknown argument' ;;
  esac
done
for command in bash awk realpath stat date id ln; do command -v "$command" >/dev/null 2>&1 || fail "required command missing: $command"; done
command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail 'Docker CLI not found'
"$DOCKER_BIN" compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is unavailable'
command -v jq >/dev/null 2>&1 || fail 'required command missing: jq (needed by the verified release script)'

read_env() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || { printf ''; return 0; }
  awk -v key="$key" '
    index($0,key "=")==1 { count++; value=substr($0,length(key)+2); sub(/\r$/, "", value); if(length(value)>=2 && substr(value,1,1)=="\"" && substr(value,length(value),1)=="\"") value=substr(value,2,length(value)-2); if(length(value)>=2 && substr(value,1,1)=="\047" && substr(value,length(value),1)=="\047") value=substr(value,2,length(value)-2) }
    END { if(count>1) exit 2; if(count==1) print value; else exit 0 }
  ' "$ENV_FILE"
}
pick() {
  local cli="$1" envname="$2" key="$3" from_file=""
  if [[ -n "$cli" ]]; then printf '%s' "$cli"; return; fi
  if [[ -n "${!envname:-}" ]]; then printf '%s' "${!envname}"; return; fi
  from_file="$(read_env "$key")" || return $?
  printf '%s' "$from_file"
}
PROJECT="$(pick "$ARG_PROJECT" TEAMSHELF_COMPOSE_PROJECT TEAMSHELF_COMPOSE_PROJECT)" || fail 'invalid project setting'
VOLUME="$(pick "$ARG_VOLUME" TEAMSHELF_DATA_VOLUME TEAMSHELF_DATA_VOLUME)" || fail 'invalid volume setting'
BACKUP_DIR="$(pick "$ARG_BACKUP_DIR" TEAMSHELF_BACKUP_DIR TEAMSHELF_BACKUP_DIR)" || fail 'invalid backup setting'
ORIGIN="$(pick "$ARG_ORIGIN" APP_ORIGIN APP_ORIGIN)" || fail 'invalid origin setting'
PORT_VALUE="$(pick "$ARG_PORT" PORT PORT)" || fail 'invalid port setting'
COOKIE_VALUE="$(pick "$ARG_COOKIE_SECURE" COOKIE_SECURE COOKIE_SECURE)" || fail 'invalid cookie setting'
IMAGE_REF="$ARG_IMAGE_REF"
[[ -n "$IMAGE_REF" ]] || IMAGE_REF="${TEAMSHELF_IMAGE_REF:-}"
[[ -n "$IMAGE_REF" ]] || IMAGE_REF="$(read_env TEAMSHELF_IMAGE_REF)" || fail 'provide --image-ref with a verified immutable GHCR digest'
PORT_VALUE="${PORT_VALUE:-8080}"
COOKIE_VALUE="${COOKIE_VALUE:-false}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'project must use lowercase letters, numbers, dash or underscore'
[[ "$VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail 'volume name contains unsupported characters'
[[ "$IMAGE_REF" =~ ^ghcr\.io/zhao-zixi/team-docs@sha256:[a-f0-9]{64}$ ]] || fail 'image ref must be this project’s ghcr.io immutable sha256 digest'
[[ "$BACKUP_DIR" == /* && "$BACKUP_DIR" != *$'\n'* && "$BACKUP_DIR" != *$'\r'* && "$BACKUP_DIR" != *'"'* && "$BACKUP_DIR" != *'$'* && "$BACKUP_DIR" != *'`'* ]] || fail 'backup path must be absolute and contain no quote, dollar, backtick, or newline'
[[ "$PORT_VALUE" =~ ^[0-9]{1,5}$ ]] && (( PORT_VALUE >= 1 && PORT_VALUE <= 65535 )) || fail 'port must be between 1 and 65535'
[[ "$COOKIE_VALUE" == true || "$COOKIE_VALUE" == false ]] || fail 'cookie-secure must be true or false'
[[ "$ORIGIN" =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]] || fail 'provide exact http(s) origin without path or trailing slash'
if [[ "$ORIGIN" =~ :([0-9]+)$ ]]; then (( BASH_REMATCH[1] >= 1 && BASH_REMATCH[1] <= 65535 )) || fail 'origin port is out of range'; fi
[[ "${OSTYPE:-}" != msys* && "${OSTYPE:-}" != cygwin* ]] || fail 'run this NAS launcher in Linux; Windows users should use source-up.ps1 for source Compose'
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -n "$ARG_ORIGIN" || -n "${APP_ORIGIN:-}" ]] || fail 'first setup requires an explicit --origin users can open'
  [[ -n "$ARG_PROJECT" && -n "$ARG_VOLUME" && -n "$ARG_BACKUP_DIR" && -n "$ARG_IMAGE_REF" ]] || fail 'first setup requires explicit project, volume, backup-dir and image-ref'
else
  for pair in "TEAMSHELF_COMPOSE_PROJECT:$PROJECT" "TEAMSHELF_DATA_VOLUME:$VOLUME" "TEAMSHELF_BACKUP_DIR:$BACKUP_DIR"; do
    key="${pair%%:*}"; selected="${pair#*:}"; stored="$(read_env "$key")" || fail ".env must contain at most one $key"
    if [[ -n "$stored" && "$stored" != "$selected" ]]; then fail "selected $key differs from existing .env; refusing to change installation identity"; fi
  done
  FILE_ORIGIN="$(read_env APP_ORIGIN)" || fail '.env must contain at most one APP_ORIGIN'
  [[ -n "$FILE_ORIGIN" && "$FILE_ORIGIN" == "$ORIGIN" ]] || fail 'selected APP_ORIGIN differs from existing .env; refusing to alter browser origin'
fi
BACKUP_LEXICAL="$(realpath -m -s -- "$BACKUP_DIR")" || fail 'cannot normalize backup path'
BACKUP_RESOLVED="$(realpath -m -- "$BACKUP_DIR")" || fail 'cannot resolve backup path'
[[ "$BACKUP_LEXICAL" == "$BACKUP_RESOLVED" ]] || fail 'backup path must not include symlinks'
BACKUP_DIR="$BACKUP_RESOLVED"
case "$BACKUP_DIR" in /tmp|/tmp/*|/var/tmp|/var/tmp/*) fail 'backup path must be persistent, not temporary' ;; esac
case "$BACKUP_DIR" in "$ROOT"|"$ROOT"/*) fail 'backup path must be outside the checkout' ;; esac
BACKUP_DIR_CREATED=0
if [[ ! -e "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]]; then
  mkdir -p -- "$(dirname -- "$BACKUP_DIR")"
  if mkdir -m 700 -- "$BACKUP_DIR" 2>/dev/null; then BACKUP_DIR_CREATED=1
  elif [[ ! -d "$BACKUP_DIR" ]]; then fail 'cannot create backup directory'; fi
fi
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail 'backup path must be a real directory'
if (( BACKUP_DIR_CREATED )); then
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *)
      HOST_UID="$(id -u)"
      "$DOCKER_BIN" run --rm --network none --user 0:0 --mount "type=bind,source=$BACKUP_DIR,target=/backup" --env "HOST_UID=$HOST_UID" --entrypoint node node:24-bookworm-slim -e "import('node:fs/promises').then(async fs=>{if((await fs.readdir('/backup')).length)throw new Error('new backup directory is not empty');await fs.chown('/backup',Number(process.env.HOST_UID),1000);await fs.chmod('/backup',0o770)})" || fail 'cannot prepare new backup directory for the host user and container group 1000'
      BACKUP_OWNER="$(stat -c '%u:%g:%a' -- "$BACKUP_DIR")" || fail 'cannot inspect initialized backup directory ownership'
      [[ "$BACKUP_OWNER" == "$HOST_UID:1000:770" ]] || fail 'new backup directory must remain host-owned and writable by container group 1000'
      ;;
  esac
fi
BACKUP_MODE="$(stat -c %a -- "$BACKUP_DIR")" || fail 'cannot inspect backup directory permissions'
if (( BACKUP_DIR_CREATED )); then
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *) [[ "$BACKUP_OWNER" == "$(id -u):1000:770" ]] || fail 'new backup directory permissions are invalid' ;;
  esac
else
  case "${OSTYPE:-}" in
    msys*|cygwin*) ;;
    *)
      BACKUP_OWNER="$(stat -c '%u:%g:%a' -- "$BACKUP_DIR")" || fail 'cannot inspect backup directory ownership'
      [[ "$BACKUP_OWNER" == "$(id -u):1000:770" ]] || (( (8#$BACKUP_MODE & 0022) == 0 || (8#$BACKUP_MODE & 01000) != 0 )) || fail 'backup directory must not be group/world writable unless sticky-bit protected'
      ;;
  esac
fi

if [[ ! -f "$ENV_FILE" ]]; then
  stage="$ROOT/.teamshelf-config-$$"
  mkdir -m 700 -- "$stage" || fail 'cannot create private config staging directory'
  stage_name="${stage##*/}"
  cleanup() { rm -rf -- "$stage"; }
  trap cleanup EXIT
  (cd "$ROOT" && "$DOCKER_BIN" run --rm --network none --user "$(id -u):$(id -g)" --mount "type=bind,source=$ROOT,target=/work" --workdir "/work/$stage_name" \
    --env "APP_ORIGIN=$ORIGIN" --env "PORT=$PORT_VALUE" --env "COOKIE_SECURE=$COOKIE_VALUE" --env DATA_DIR=/app/data \
    node:24-bookworm-slim node /work/scripts/configure.mjs) || fail 'Node 24 Docker config generation failed; no .env was installed'
  printf 'TEAMSHELF_COMPOSE_PROJECT=%s\nTEAMSHELF_DATA_VOLUME=%s\nTEAMSHELF_BACKUP_DIR="%s"\nTEAMSHELF_IMAGE_REF=%s\n' "$PROJECT" "$VOLUME" "$BACKUP_DIR" "$IMAGE_REF" >>"$stage/.env"
  chmod 600 "$stage/.env"
  ln -- "$stage/.env" "$ENV_FILE" 2>/dev/null || fail 'a .env appeared during setup; it was left unchanged, review and retry'
  printf 'Created private .env with a one-time SETUP_TOKEN; retrieve it locally from %s when opening the first-run setup page.\n' "$ENV_FILE"
  cleanup
  trap - EXIT
fi

export TEAMSHELF_ENV_FILE="$ENV_FILE" TEAMSHELF_IMAGE_REF="$IMAGE_REF"
args=()
if (( INIT_VOLUME )); then args+=(--init-volume); fi
exec bash "$ROOT/deploy/release.sh" "${args[@]}"
