#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ZF_PROFILE_DIR:-/data/browser-profile}" \
  "${CRAWLEE_STORAGE_DIR:-/data/crawlee-storage}" \
  "$(dirname "${ZF_ENGAGED_DB:-/data/engaged-lotteries.sqlite}")"

run_crawler_once() {
  local run_mode="${1:-full}"
  local timeout_seconds="${CRAWLER_RUN_TIMEOUT_SECONDS:-1800}"
  local kill_after_seconds="${CRAWLER_KILL_AFTER_SECONDS:-5}"
  local status
  local -a crawler_command=(node zfrontier-lottery-crawler.js)
  if [ "$run_mode" = "hourly" ]; then
    crawler_command+=(--tracked-only)
    timeout_seconds="${HOURLY_RUN_TIMEOUT_SECONDS:-120}"
  elif [ "$run_mode" = "messages" ]; then
    crawler_command+=(--messages-only)
    timeout_seconds="${MESSAGE_FETCH_TIMEOUT_SECONDS:-840}"
  fi

  echo "[crawler] starting ${run_mode} run at $(date -Is)"
  if timeout --preserve-status --kill-after="${kill_after_seconds}s" "${timeout_seconds}s" "${crawler_command[@]}"; then
    echo "[crawler] completed ${run_mode} run at $(date -Is)"
    return 0
  else
    status=$?
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || [ "$status" -eq 143 ]; then
      echo "[crawler] timed out after ${timeout_seconds}s; killed run at $(date -Is)" >&2
      return 75
    else
      echo "[crawler] failed with exit code ${status} at $(date -Is)" >&2
      return "$status"
    fi
  fi
}

message_loop() {
  local interval="${MESSAGE_FETCH_INTERVAL_SECONDS:-900}"
  local started elapsed remaining status
  if ! [[ "$interval" =~ ^[1-9][0-9]*$ ]]; then
    echo "[messages] MESSAGE_FETCH_INTERVAL_SECONDS must be a positive integer" >&2
    return 1
  fi
  while true; do
    started=$SECONDS
    status=0
    run_crawler_once messages || status=$?
    elapsed=$((SECONDS - started))
    remaining=$((interval - elapsed))
    if [ "$status" -ne 0 ]; then remaining="${CRAWLER_RESTART_DELAY_SECONDS:-60}"; fi
    if [ "$remaining" -lt 1 ]; then remaining=1; fi
    sleep "$remaining"
  done
}

crawler_loop() {
  local interval="${CRAWL_INTERVAL_SECONDS:-3600}"
  local restart_delay="${CRAWLER_RESTART_DELAY_SECONDS:-60}"
  local started remaining status
  if [ "${RUN_ON_START:-1}" != "1" ]; then sleep "$interval"; fi
  while true; do
    started=$SECONDS
    status=0
    run_crawler_once full || status=$?
    remaining=$((interval - (SECONDS - started)))
    if [ "$status" -ne 0 ]; then remaining="$restart_delay"; fi
    if [ "$remaining" -lt 1 ]; then remaining=1; fi
    sleep "$remaining"
  done
}

lottery_loop() {
  local poll_seconds="${LOTTERY_POLL_SECONDS:-5}"
  local retry_seconds="${HOURLY_RETRY_SECONDS:-60}"
  local delay sleep_seconds
  if ! [[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]]; then
    echo "[lottery] LOTTERY_POLL_SECONDS must be a positive integer" >&2
    return 1
  fi
  while true; do
    if ! delay="$(node zfrontier-lottery-crawler.js --next-hourly-delay)"; then
      sleep "$retry_seconds"
    elif [[ "$delay" =~ ^[0-9]+$ ]] && [ "$delay" -eq 0 ]; then
      # Each worker invocation selects just one post and waits for its own time.
      run_crawler_once hourly || sleep "$retry_seconds"
    else
      sleep_seconds="$poll_seconds"
      if [[ "$delay" =~ ^[0-9]+$ ]] && [ "$delay" -lt "$sleep_seconds" ]; then
        sleep_seconds="$delay"
      fi
      sleep "$sleep_seconds"
    fi
  done
}

cleanup() {
  echo "[entrypoint] shutting down"
  kill "${crawler_pid:-}" "${message_pid:-}" "${lottery_pid:-}" "${server_pid:-}" 2>/dev/null || true
  wait "${crawler_pid:-}" "${message_pid:-}" "${lottery_pid:-}" "${server_pid:-}" 2>/dev/null || true
}

trap cleanup INT TERM

crawler_loop &
crawler_pid=$!

message_loop &
message_pid=$!

lottery_loop &
lottery_pid=$!

zfrontier-report-server &
server_pid=$!

wait -n "$crawler_pid" "$message_pid" "$lottery_pid" "$server_pid"
status=$?
cleanup
exit "$status"
