#!/usr/bin/env bash
# The first command disables inherited tracing before any arguments are read.
set +x +v
set -eo pipefail
umask 077

fail() { printf 'Comand: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Comand — установка агента без Git, npm и sudo.
bash install.sh --url https://comand.example --code CODE [--allow-shell] [--allow-browser]
  [--name NAME] [--root /absolute/project] [--root /another/project]
  [--profile PROFILE] [--data-dir /absolute/state] [--install-dir /absolute/program] [--no-service]
bash install.sh --update --url https://comand.example [--data-dir /absolute/state]
  [--profile PROFILE] [--install-dir /absolute/program] [--no-service]
Имя компьютера определяется автоматически. Рабочая папка по умолчанию: ~/Comand.
Существующие учётные данные сохраняются. Обновление не требует нового кода.
HELP
}

hub_url=''
pair_code=''
device_name=''
roots=()
capabilities=()
data_dir="${HOME:?HOME is required}/.comand/agent"
install_dir="$HOME/.local/share/comand"
profile=''
custom_data=0
custom_install=0
update=0
no_service=0
default_root=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --update) update=1; shift ;;
    --no-service) no_service=1; shift ;;
    --allow-shell|--allow-browser) capabilities+=("$1"); shift ;;
    --url|--code|--name|--root|--profile|--data-dir|--install-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || fail 'У параметра отсутствует значение.'
      case "$1" in
        --url) hub_url="$2" ;;
        --code) pair_code="$2" ;;
        --name) device_name="$2" ;;
        --root) roots+=("$2") ;;
        --profile) profile="$2" ;;
        --data-dir) data_dir="$2"; custom_data=1 ;;
        --install-dir) install_dir="$2"; custom_install=1 ;;
      esac
      shift 2 ;;
    *) fail 'Неизвестный параметр. Используйте --help.' ;;
  esac
done

if [ "$update" -eq 0 ] && [ "${#roots[@]}" -eq 0 ]; then
  roots=("$HOME/Comand")
  default_root=1
fi

# Accept an origin only; credentials, paths, queries and fragments cannot reach curl.
https_origin='^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?/?$'
loopback_origin='^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/?$'
[[ "$hub_url" =~ $https_origin || "$hub_url" =~ $loopback_origin ]] || fail 'Нужен HTTPS-адрес сервера без пути. HTTP допустим только для loopback.'
hub_url="${hub_url%/}"
# The web command supplies a stable account profile. Combine it with the origin
# so another hub/account cannot replace the legacy agent or share its release link.
if [ -n "$profile" ]; then
  [[ "$profile" =~ ^[a-f0-9]{64}$ ]] || fail 'Некорректный профиль подключения. Скопируйте новую команду из панели.'
  if command -v sha256sum >/dev/null 2>&1; then
    connection=$(printf '%s\n%s' "$hub_url" "$profile" | sha256sum | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    connection=$(printf '%s\n%s' "$hub_url" "$profile" | shasum -a 256 | awk '{print $1}')
  else fail 'Не найдена программа shasum или sha256sum.'; fi
  [ "$custom_data" -eq 1 ] || data_dir="$HOME/.comand/connections/$connection"
  [ "$custom_install" -eq 1 ] || install_dir="$HOME/.local/share/comand-connections/$connection"
fi
for directory in "$install_dir" "$data_dir" "${roots[@]}"; do
  [[ "$directory" == /* && "$directory" != *$'\n'* && "$directory" != *$'\r'* ]] || fail 'Папки должны иметь абсолютные пути без переводов строк.'
done
[[ "$install_dir" != *\\* ]] || fail 'Node.js не поддерживает обратную косую черту в пути программы. Выберите другую --install-dir.'
[ "$(id -u)" -ne 0 ] || fail 'Запустите установщик от обычного пользователя, без sudo.'
if [ "$update" -eq 1 ]; then
  [ -z "$pair_code" ] && [ -z "$device_name" ] && [ "${#roots[@]}" -eq 0 ] && [ "${#capabilities[@]}" -eq 0 ] || fail 'При обновлении не передавайте код, имя, папки и разрешения: они сохраняются.'
  [ -f "$data_dir/config.json" ] && [ ! -L "$data_dir/config.json" ] || fail 'Для обновления нужна существующая конфигурация агента.'
else
  [ -n "$pair_code" ] || fail 'Для подключения нужен --code.'
  [ ! -e "$data_dir/config.json" ] && [ ! -L "$data_dir/config.json" ] || fail "Этот агент уже подключён. Его ключ сохранён. Проверьте раздел «Устройства». Для обновления замените --code и разрешения на --update, сохранив --url, --profile и выбранные пути. Состояние: $data_dir"
fi
for directory in "${roots[@]}"; do
  if [ "$default_root" -eq 1 ]; then
    [ ! -L "$directory" ] || fail 'Папка ~/Comand не должна быть символической ссылкой. Выберите другую рабочую папку через --root.'
    if [ -e "$directory" ]; then
      [ -d "$directory" ] && [ -O "$directory" ] || fail 'Папка ~/Comand должна принадлежать текущему пользователю.'
    fi
  else
    [ -d "$directory" ] || fail 'Рабочая папка не существует. Создайте её и повторите установку.'
  fi
done
for executable in curl tar gzip mktemp shasum; do
  command -v "$executable" >/dev/null 2>&1 || {
    [ "$executable" = shasum ] && command -v sha256sum >/dev/null 2>&1 || fail "Не найдена необходимая программа: $executable"
  }
done
case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) fail 'Поддерживаются только macOS и Linux.' ;; esac
case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) fail 'Поддерживаются только x64 и arm64.' ;; esac

for directory in "$install_dir" "$data_dir"; do
  [ ! -L "$directory" ] || fail 'Папка установки или состояния не должна быть символической ссылкой.'
  if [ -e "$directory" ]; then
    [ -d "$directory" ] && [ -O "$directory" ] || fail 'Папка должна принадлежать текущему пользователю.'
  fi
done
if [ -d "$install_dir" ] && [ ! -f "$install_dir/.comand-install" ]; then
  [ -z "$(ls -A "$install_dir")" ] || fail 'Выберите отдельную пустую --install-dir.'
fi
mkdir -p "$install_dir" "$data_dir"
chmod 700 "$install_dir" "$data_dir"
if [ -e "$install_dir/.comand-install" ] || [ -L "$install_dir/.comand-install" ]; then
  [ -f "$install_dir/.comand-install" ] && [ ! -L "$install_dir/.comand-install" ] || fail 'Некорректный маркер папки установки.'
else
  (set -C; : > "$install_dir/.comand-install") || fail 'Не удалось создать маркер папки установки.'
fi
install_locked=0
state_locked=0
stage=''
switched=0
committed=0
old_current=''
node_exec=''
cleanup() {
  status=$?
  trap - EXIT
  if [ "$switched" -eq 1 ] && [ "$committed" -eq 0 ]; then
    if [ -n "$old_current" ]; then
      "$node_exec" -e 'const f=require("node:fs"),p=process.argv[1]; f.symlinkSync(process.argv[2],p+"/.rollback"); f.renameSync(p+"/.rollback",p+"/current");' "$install_dir" "$old_current" || true
      if [ "$no_service" -eq 0 ]; then
        "$node_exec" "$install_dir/current/dist/cli.js" service install --kind agent --data-dir "$data_dir" >/dev/null 2>&1 &&
          "$node_exec" "$install_dir/current/dist/cli.js" service restart --kind agent --data-dir "$data_dir" >/dev/null 2>&1 || true
      fi
      printf 'Comand: восстановлена предыдущая версия программы. Проверьте состояние службы.\n' >&2
    fi
  fi
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ "$state_locked" -eq 0 ] || rmdir "$data_dir/.install-lock" 2>/dev/null || true
  [ "$install_locked" -eq 0 ] || rmdir "$install_dir/.install-lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$install_dir/.install-lock" 2>/dev/null || fail 'Другая установка уже работает (или осталась .install-lock после сбоя).'
install_locked=1
mkdir "$data_dir/.install-lock" 2>/dev/null || fail 'Другая установка использует эту папку состояния.'
state_locked=1
stage=$(mktemp -d "$install_dir/.stage.XXXXXXXX")
download() {
  curl --fail --silent --show-error --location --max-redirs 0 --connect-timeout 15 --max-time 600 \
    --proto '=https,http' --proto-redir '=https' --output "$2" "$1"
}
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | awk '{print $1}'
  else shasum -a 256 < "$1" | awk '{print $1}'; fi
}
verify() {
  expected=$(awk -v name="$3" '$2 == name && length($1) == 64 { print $1 }' "$2")
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Файл контрольной суммы некорректен.'
  [ "$(digest "$1")" = "$expected" ] || fail 'Контрольная сумма не совпала. Программа не установлена; повторите загрузку.'
}

if [ -x "$install_dir/node" ] && [ "$("$install_dir/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 24 ]; then
  node_exec="$install_dir/node"
elif command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 24 ]; then
  node_exec=$(command -v node)
else
  node_version=24.22.1
  node_name="node-v${node_version}-${node_os}-${node_arch}"
  printf 'Загрузка Node.js %s для %s/%s…\n' "$node_version" "$node_os" "$node_arch"
  download "https://nodejs.org/dist/v${node_version}/${node_name}.tar.gz" "$stage/node.tar.gz"
  download "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" "$stage/node.sha256"
  verify "$stage/node.tar.gz" "$stage/node.sha256" "$node_name.tar.gz"
  mkdir "$stage/node"
  tar -xzf "$stage/node.tar.gz" -C "$stage/node" --strip-components=1
  [ "$("$stage/node/bin/node" -p 'process.versions.node' 2>/dev/null)" = "$node_version" ] || fail 'Node.js не запускается. Проверьте совместимость ОС (Linux требует glibc).'
  mkdir -p "$install_dir/runtimes"
  # A damaged existing runtime is never overwritten in place.
  runtime_dir="$install_dir/runtimes/${node_name}-$(digest "$stage/node.tar.gz" | cut -c1-12)"
  [ ! -e "$runtime_dir" ] || fail 'Каталог Node.js уже существует, но не используется. Проверьте прежнюю установку.'
  mv "$stage/node" "$runtime_dir"
  node_exec="$runtime_dir/bin/node"
fi
node_exec=$("$node_exec" -p 'require("node:fs").realpathSync(process.execPath)')

# Resolve paths once and reject overlapping runtime/state before downloading code.
"$node_exec" - "$install_dir" "$data_dir" "$hub_url" "$update" "$default_root" "$HOME" <<'VALIDATE'
const fs = require('node:fs');
const path = require('node:path');
const [install, data, rawUrl, update, defaultRoot, home] = process.argv.slice(2);
const a = fs.realpathSync(install), b = fs.realpathSync(data), url = new URL(rawUrl);
if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('Папки программы и состояния должны быть раздельными.');
if (url.origin !== rawUrl) throw Error('Нужен нормализованный origin сервера.');
if (update === '1') {
  const config = JSON.parse(fs.readFileSync(path.join(b, 'config.json'), 'utf8'));
  if (config.hubUrl.replace(/\/$/, '') !== rawUrl) throw Error('Обновляйте агент с адреса его существующего сервера.');
} else if (fs.existsSync(path.join(b, 'config.json'))) throw Error('Агент уже подключён; ключ не изменён.');
if (defaultRoot === '1') {
  const workspace = path.join(fs.realpathSync(home), 'Comand');
  for (const directory of [a, b]) {
    if (workspace === directory || workspace.startsWith(directory + path.sep) || directory.startsWith(workspace + path.sep)) throw Error('Рабочая папка ~/Comand должна быть отделена от программы и состояния.');
  }
  try { fs.mkdirSync(workspace, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('Папка ~/Comand должна быть обычной папкой текущего пользователя.');
}
VALIDATE
if [ "$update" -eq 0 ] && [ -z "$device_name" ]; then
  device_name=$("$node_exec" -p 'const name = require("node:os").hostname().replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim(); ((name && !name.startsWith("--")) ? name : "Comand computer").slice(0, 100)')
fi
install_dir=$(cd "$install_dir" && pwd -P)
data_dir=$(cd "$data_dir" && pwd -P)
printf 'Загрузка и проверка Comand…\n'
download "$hub_url/downloads/comand-agent.tar.gz" "$stage/comand-agent.tar.gz"
download "$hub_url/downloads/comand-agent.tar.gz.sha256" "$stage/comand-agent.tar.gz.sha256"
verify "$stage/comand-agent.tar.gz" "$stage/comand-agent.tar.gz.sha256" comand-agent.tar.gz
archive_hash=$(digest "$stage/comand-agent.tar.gz")

# Inspect actual tar headers before extraction. No links, traversal, devices,
# alternate roots, PAX overrides, duplicate entries or unexpected top-level files.
"$node_exec" - "$stage/comand-agent.tar.gz" <<'ARCHIVE'
const fs = require('node:fs'), zlib = require('node:zlib');
const data = zlib.gunzipSync(fs.readFileSync(process.argv[2]), { maxOutputLength: 512 * 1024 * 1024 });
const seen = new Set();
let offset = 0;
for (; offset + 512 <= data.length; ) {
  const header = data.subarray(offset, offset + 512);
  if (header.every(b => b === 0)) break;
  const text = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
  const prefix = text(345, 155), name = (prefix ? prefix + '/' : '') + text(0, 100);
  const sizeText = text(124, 12).trim();
  const size = parseInt(sizeText, 8), type = text(156, 1);
  if (!/^[0-7]+$/.test(sizeText) || !Number.isSafeInteger(size) || !['0', '', '5'].includes(type)) throw Error('Недопустимый тип записи архива.');
  if (!/^comand-agent\/(?:dist(?:\/|$)|node_modules(?:\/|$)|(?:package(?:-lock)?\.json|release\.json)$)/.test(name) || name.split('/').some(s => s === '..' || s === '.') || /[\r\n\\]/.test(name) || seen.has(name)) throw Error('Недопустимый путь в архиве.');
  seen.add(name);
  const checksum = parseInt(text(148, 8).trim(), 8);
  const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (checksum !== actual || (type === '5' && size !== 0)) throw Error('Некорректный заголовок архива.');
  offset += 512 + Math.ceil(size / 512) * 512;
  if (offset > data.length) throw Error('Архив оборван.');
}
if (!seen.has('comand-agent/release.json') || !seen.has('comand-agent/dist/agent/cli.js') || !seen.has('comand-agent/dist/cli.js') || data.subarray(offset).some(b => b !== 0)) throw Error('Неполный архив агента.');
ARCHIVE
mkdir "$stage/package"
tar -xzf "$stage/comand-agent.tar.gz" -C "$stage/package" --strip-components=1
version=$("$node_exec" - "$stage/package/release.json" <<'VERSION'
const data = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (data.name !== 'comand-agent' || data.nodeMajor !== 24 || data.format !== 1 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.version)) throw Error('Неподдерживаемый выпуск.');
process.stdout.write(data.version);
VERSION
)
[ "$("$node_exec" "$stage/package/dist/cli.js" version)" = "$version" ] || fail 'Версия программы не совпадает с манифестом.'
mkdir -p "$install_dir/releases" "$install_dir/bin"
release_dir="$install_dir/releases/$version-${archive_hash:0:12}"
if [ -e "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || fail 'Некорректный каталог выпуска.'
  # Reuse immutable files only when a prior install completed this exact digest.
  [ "$(cat "$release_dir/.archive-sha256" 2>/dev/null)" = "$archive_hash" ] || fail 'Каталог выпуска уже существует без подтверждённой контрольной суммы.'
else
  printf '%s\n' "$archive_hash" > "$stage/package/.archive-sha256"
  mv "$stage/package" "$release_dir"
fi
if [ "$update" -eq 0 ]; then
  [ ! -e "$data_dir/config.json" ] && [ ! -L "$data_dir/config.json" ] || fail 'Агент уже подключён; ключ не изменён.'
  if [ "$default_root" -eq 1 ]; then
    [ ! -L "$HOME/Comand" ] && [ -d "$HOME/Comand" ] && [ -O "$HOME/Comand" ] || fail 'Папка ~/Comand изменилась во время установки. Проверьте её и повторите подключение.'
  fi
  pair_args=(pair --url "$hub_url" --code "$pair_code" --name "$device_name" --data-dir "$data_dir")
  for directory in "${roots[@]}"; do pair_args+=(--root "$directory"); done
  "$node_exec" "$release_dir/dist/agent/cli.js" "${pair_args[@]}" "${capabilities[@]}"
  pair_code=''
  unset pair_args
fi

if [ -e "$install_dir/current" ] || [ -L "$install_dir/current" ]; then
  [ -L "$install_dir/current" ] || fail 'current должен быть ссылкой, созданной установщиком.'
  old_current=$(readlink "$install_dir/current")
fi
switched=1
"$node_exec" - "$install_dir" "$release_dir" "$node_exec" <<'SWITCH'
const fs = require('node:fs'), path = require('node:path');
const [base, release, node] = process.argv.slice(2);
for (const [name, value] of [['current', release], ['node', node]]) {
  const temp = path.join(base, '.' + name + '-next');
  fs.symlinkSync(value, temp);
  fs.renameSync(temp, path.join(base, name));
}
SWITCH
cat > "$stage/comand" <<'WRAPPER'
#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec "$base/node" "$base/current/dist/cli.js" "$@"
WRAPPER
chmod 700 "$stage/comand"
mv "$stage/comand" "$install_dir/bin/comand"
if [ "$no_service" -eq 0 ]; then
  if ! "$node_exec" "$release_dir/dist/cli.js" service install --kind agent --data-dir "$data_dir" ||
     ! "$node_exec" "$release_dir/dist/cli.js" service restart --kind agent --data-dir "$data_dir"; then
    fail 'Не удалось запустить пользовательскую службу. Ключ сохранён. Проверьте launchd/systemd и повторите с --update; для ручного запуска есть --no-service.'
  fi
fi
committed=1
printf '\nComand %s установлен. Данные агента: %s\n' "$version" "$data_dir"
printf 'Программа: %s\n' "$install_dir"
printf 'Состояние: '; printf '%q ' "$install_dir/bin/comand" agent status --data-dir "$data_dir"; printf '\n'
if [ "$no_service" -eq 1 ]; then
  printf 'Ручной запуск: '; printf '%q ' "$install_dir/bin/comand" agent run --data-dir "$data_dir"; printf '\n'
fi
