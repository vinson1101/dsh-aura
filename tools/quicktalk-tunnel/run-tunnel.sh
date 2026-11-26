#!/bin/sh
# Aura QuickTalk SSH tunnel supervisor wrapper (launchd KeepAlive target).
# Logs only timestamps, pids and exit codes. Credentials never appear in this file or its log.
DIR="$HOME/Library/Application Support/aura-quicktalk-tunnel"
LOG="$HOME/Library/Logs/aura-quicktalk-tunnel.log"
mkdir -p "$HOME/Library/Logs"
printf '%s start pid=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" >> "$LOG"
SSH_ASKPASS="$DIR/askpass.sh" SSH_ASKPASS_REQUIRE=force \
/usr/bin/ssh -N \
  -L 127.0.0.1:18765:127.0.0.1:18765 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o NumberOfPasswordPrompts=1 \
  -o StrictHostKeyChecking=yes \
  -o LogLevel=ERROR \
  ubuntuli@192.168.1.132 >> "$LOG" 2>&1
code=$?
printf '%s exit code=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$code" >> "$LOG"
exit $code
