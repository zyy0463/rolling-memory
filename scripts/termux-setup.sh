#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# termux-setup.sh — 在 Termux（安卓手机）上一键把 rolling-memory 跑起来
#
# 用法（在仓库根目录）：
#   bash scripts/termux-setup.sh
#
# 它会做四件事：检查 Node → 问你要结算 key → 写 .env → 用 tmux 起在后台。
# 重复运行是安全的（会先停掉旧的再起新的）。想重填配置加 --force。
#
# 非 Termux 环境（普通电脑/VPS）也能跑，只是不会拿唤醒锁。
# ============================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || { echo "[x] 进不去目录：$ROOT"; exit 1; }

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '%s\n' "$*"; }
die() { printf '\n[x] %s\n' "$*"; exit 1; }

say "======================================"
say " rolling-memory · 一键配置"
say " 目录：$ROOT"
say "======================================"
say ""

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  die "没装 Node。先跑：pkg install -y nodejs-lts"
fi
NODE_V="$(node -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_V%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "读不出 Node 版本（$NODE_V），重装一下：pkg install -y nodejs-lts" ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node 版本太低（v$NODE_V），需要 ≥18。跑：pkg install -y nodejs-lts"
fi
say "[1/4] Node v$NODE_V ✓"

# ---------- 2. 收配置 ----------
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ] && [ "$FORCE" = "0" ]; then
  say "[2/4] 已有 .env，跳过（想重填就加 --force）"
  LEDGER_MODEL_SHOW="$(grep -E '^LEDGER_MODEL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  say "      当前结算模型：${LEDGER_MODEL_SHOW:-未设置}"
else
  say "[2/4] 填配置（只问三个，其它用默认）"
  say ""
  say "  · 结算模型负责把聊过的内容压成摘要，建议用便宜的。"
  say "  · 直接回车 = 用括号里的默认值。"
  say ""
  printf '  结算接口地址 [https://api.deepseek.com/v1/chat/completions]: '
  read -r IN_URL || IN_URL=""
  IN_URL="${IN_URL:-https://api.deepseek.com/v1/chat/completions}"

  printf '  结算 API Key（sk- 开头，粘贴进去就行）: '
  read -r IN_KEY || IN_KEY=""
  IN_KEY="$(printf '%s' "${IN_KEY}" | tr -d ' \r\n')"
  [ -z "$IN_KEY" ] && die "Key 不能为空。没有的话去 https://platform.deepseek.com 申请一个。"

  printf '  结算模型名 [deepseek-chat]: '
  read -r IN_MODEL || IN_MODEL=""
  IN_MODEL="${IN_MODEL:-deepseek-chat}"

  printf '  对话走中转站？填中转站地址，不走就回车跳过: '
  read -r IN_CHAT || IN_CHAT=""
  IN_CHAT="$(printf '%s' "${IN_CHAT}" | tr -d ' \r\n')"

  {
    printf '%s\n' "# 由 scripts/termux-setup.sh 生成于 $(date '+%Y-%m-%d %H:%M')"
    printf '%s\n' "LEDGER_API_URL=$IN_URL"
    printf '%s\n' "LEDGER_API_KEY=$IN_KEY"
    printf '%s\n' "LEDGER_MODEL=$IN_MODEL"
    if [ -n "$IN_CHAT" ]; then
      printf '%s\n' "CHAT_API_URL=$IN_CHAT"
      printf '%s\n' "# CHAT_API_KEY 留空即可：客户端自带的 Authorization 会原样透传"
    fi
    printf '%s\n' ""
    printf '%s\n' "# 攒够几条滑出消息结算一次（觉得记太碎就调大，6 是默认值）"
    printf '%s\n' "LEDGER_BUFFER_COUNT=6"
  } > "$ENV_FILE"

  chmod 600 "$ENV_FILE" 2>/dev/null
  say "      .env 已写好（权限 600，只有本机用户能读）"
fi

# ---------- 3. 端口占用了就先停旧进程 ----------
PORT="$(grep -E '^PROXY_PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
PORT="${PORT:-8787}"
if command -v pkill >/dev/null 2>&1; then
  pkill -f "node proxy.js" 2>/dev/null && say "[3/4] 停掉了一个正在跑的旧代理"
fi
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t rm 2>/dev/null
  say "[3/4] 用 tmux 起在后台（关掉 Termux 也不停）"
elif command -v pkg >/dev/null 2>&1; then
  say "[3/4] 装 tmux（让代理脱离终端跑，关掉 Termux 也不停）"
  pkg install -y tmux >/dev/null 2>&1
  if command -v tmux >/dev/null 2>&1; then
    say "      tmux 装好了"
  else
    say "      tmux 没装上，退化成 nohup（也能跑，但关掉 Termux 可能会停）"
  fi
else
  say "[3/4] 没有 tmux，用 nohup 起在后台"
fi

# ---------- 4. 起服务 ----------
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null && say "[4/4] 已拿唤醒锁（防止系统杀后台）"
fi

if command -v tmux >/dev/null 2>&1; then
  tmux new -d -s rm "cd '$ROOT' && node proxy.js >> '$ROOT/proxy.log' 2>&1"
else
  nohup node proxy.js >> "$ROOT/proxy.log" 2>&1 &
fi
sleep 2

# ---------- 自检 ----------
CHECK="$(curl -s --max-time 4 "http://127.0.0.1:$PORT" 2>/dev/null | head -1)"
say ""
if [ -n "$CHECK" ]; then
  say "================ 起来了 ================"
  say ""
  say "  把聊天 App 的「接口地址」改成："
  say ""
  say "      http://127.0.0.1:$PORT/v1/chat/completions"
  say ""
  say "  密钥不用动，模型名不用动，之后想切模型随时切。"
  say ""
  LAN_IP="$( (command -v ifconfig >/dev/null 2>&1 && ifconfig 2>/dev/null) \
    | grep -oE 'inet (addr:)?(192|10|172)\.[0-9.]+' \
    | sed 's/inet addr://; s/inet //' | head -2 )"
  if [ -n "$LAN_IP" ]; then
    say "  如果聊天 App 装在别的设备上，把 127.0.0.1 换成这个："
    printf '%s\n' "$LAN_IP" | sed 's/^/      /'
    say ""
  fi
  say "  常用命令："
  say "      tmux ls                    看代理活着没有"
  say "      tmux attach -t rm          进去看日志（Ctrl+B 再按 D 退出）"
  say "      tail -f proxy.log          只看日志"
  say "      npm run view               看记忆内容 → http://127.0.0.1:8788"
  say "      bash scripts/termux-setup.sh --force   重填配置"
  say ""
  say "======================================"
  say ""
  say "  还没做的话，强烈建议补两步（否则第二天记忆会没）："
  say "    ① 系统设置里把 Termux 的电池优化设为「无限制」"
  say "    ② 装 Termux:Boot 做开机自启（见 docs/手机端配置教程.md 的 A9）"
else
  say "[x] 代理没起来。最后 20 行日志："
  say "--------------------------------------"
  tail -20 "$ROOT/proxy.log" 2>/dev/null || say "（没有日志文件）"
  say "--------------------------------------"
  say "对照 docs/手机端配置教程.md 的「排错表」逐条看。"
  exit 1
fi
