#!/usr/bin/env bash
# 여러 종의 attack/attacked 를 나란히 굽는다.
#
#   bash scripts/_fxbatch.sh <동시개수> <종> [종 ...]
#
# 한 번에 하나씩 부르면 한 장에 2~6분이라 17종이면 몇 시간이다. API job 은 서버에서 도는 것이라
# 몇 개를 동시에 띄워도 서로 안 막는다. 다만 너무 많이 띄우면 쿼터·네트워크가 흔들리므로
# 동시개수를 밖에서 정한다(3 정도가 안전).
#
# ⚠️ 실패해도 멈추지 않는다 — 한 종이 타임아웃 나도 나머지는 끝까지 굽고, 마지막에 실패 목록을 낸다.
set -u
N="$1"; shift
export PIXELLAB_API_KEY="$(tr -d '\r\n' < "$(dirname "$0")/.pixellab.key")"
LOG_DIR="$(dirname "$0")/../_fxbatch-logs"
mkdir -p "$LOG_DIR"

one() { # one <종> <step>
  local name="$1" step="$2" log="$LOG_DIR/$1-$2.log"
  if node "$(dirname "$0")/generate_skill_fx.mjs" "$name" --step "$step" > "$log" 2>&1; then
    echo "  ✓ $name/$step"
  else
    # 왜 죽었는지 한 줄로. API 가 거절한 경우 이유는 "detail" 에 있고, 그 밖은 Error 줄에 있다.
    local why
    why="$(grep -oE '"detail":"[^"]*"' "$log" | head -1)"
    [ -z "$why" ] && why="$(grep -m1 -oE '^Error: .*' "$log" | head -c 140)"
    echo "  ✗ $name/$step   ${why:-이유는 $log 를 볼 것}"
  fi
}

pids=()
for name in "$@"; do
  for step in attack attacked; do
    one "$name" "$step" &
    pids+=($!)
    while [ "$(jobs -rp | wc -l)" -ge "$N" ]; do wait -n; done
  done
done
wait
echo "--- 끝. 로그는 $LOG_DIR ---"
