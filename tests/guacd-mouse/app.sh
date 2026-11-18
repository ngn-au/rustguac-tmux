#!/bin/sh
# Login shell of the test user. /tmp/mode picks what it does before it
# records its raw input to /tmp/got:
#   on     xterm mouse tracking on (any-event + SGR), as tmux does for Claude
#   off    nothing
#   osc52  mouse tracking on, and copies "hello-osc52" with OSC 52 (as Claude
#          Code or tmux copy mode does)
stty raw -echo
m=$(cat /tmp/mode 2>/dev/null)
case "$m" in on|osc52) printf '\033[?1003h\033[?1006h';; esac
[ "$m" = osc52 ] && printf '\033]52;c;aGVsbG8tb3NjNTI=\007'
printf 'READY'
timeout --foreground 15 dd bs=1 count=200 of=/tmp/got 2>/dev/null
