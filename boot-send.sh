#!/bin/bash
# Runs on every boot (via systemd). Picks the greeting for the current hour,
# sends it, alerts on failure, then stops the instance. Designed for the
# EventBridge "start instance before each send time" schedule.
#
# Guards:
#   - Outside the send-window hours -> assume a manual/maintenance boot:
#     do nothing and DO NOT shut down (so you can SSH in and work).
#   - DRY_RUN marker file or WA_DRY_RUN=1 -> exercise the full path without
#     messaging anyone (still self-stops unless WA_NO_SHUTDOWN=1).
set -uo pipefail

WA_DIR=/home/ubuntu/wa-bot
NODE=/usr/bin/node
LOG="$WA_DIR/log.txt"

# Private, host-local settings (gitignored). See .env.example.
# Provides AWS_REGION and SNS_TOPIC_ARN without baking account IDs into code.
if [ -f "$WA_DIR/.env" ]; then set -a; . "$WA_DIR/.env"; set +a; fi
REGION="${AWS_REGION:-us-east-1}"
TOPIC_ARN="${SNS_TOPIC_ARN:-}"
HOUR=$(date +%H)   # local time = Asia/Kolkata (set on the host)

DRY=""
if [ -f "$WA_DIR/DRY_RUN" ] || [ "${WA_DRY_RUN:-}" = "1" ]; then DRY="--dry-run"; fi

if [ -n "$DRY" ]; then
  MSG="DRY-RUN test (no real message)"
else
  case "$HOUR" in
    07|08) MSG="Good morning! ☀️" ;;
    12|13) MSG="Good afternoon! 🌤️" ;;
    18|19) MSG="Good evening! 🌙" ;;
    *)
      echo "$(date) boot outside send window (hour=$HOUR) -> maintenance mode, no send/shutdown" >> "$LOG"
      exit 0 ;;
  esac
fi

cd "$WA_DIR" || exit 1
echo "$(date) === boot-send start (hour=$HOUR msg='$MSG' dry='${DRY:-no}') ===" >> "$LOG"
WA_TIMEOUT_MS=240000 "$NODE" send.js --message "$MSG" $DRY >> "$LOG" 2>&1
RC=$?
echo "$(date) boot-send finished rc=$RC" >> "$LOG"

if [ "$RC" -ne 0 ]; then
  if [ -n "$TOPIC_ARN" ]; then
    aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" \
      --subject "wa-bot send FAILED (rc=$RC)" \
      --message "wa-bot failed at $(date) on $(hostname).
message: $MSG
exit code: $RC

Last 20 log lines:
$(tail -n 20 "$LOG")" >> "$LOG" 2>&1
    echo "$(date) failure alert published to SNS" >> "$LOG"
  else
    echo "$(date) send failed but no SNS_TOPIC_ARN configured; skipping alert" >> "$LOG"
  fi
fi

if [ "${WA_NO_SHUTDOWN:-}" = "1" ]; then
  echo "$(date) WA_NO_SHUTDOWN set -> staying up" >> "$LOG"
  exit "$RC"
fi

echo "$(date) self-stopping instance" >> "$LOG"
sudo /sbin/shutdown -h +0
