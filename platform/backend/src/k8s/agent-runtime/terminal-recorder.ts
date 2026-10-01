/** Decode tmux's ordered control stream without introducing image dependencies. */
export function buildTerminalRecorderScript(): string {
  const dollar = "$";
  return String.raw`set -eu
turn="$1"
pane=""
window=""
geometry=""
trap 'exit 1' HUP INT TERM
detached=0
emit() {
  # Keep encoded bytes in shell variables; decode directly at each destination
  # so NUL survives and either failed write stops this process.
  printf '%b' "$1" >> "$turn.log"
  printf '%b' "$1"
}
record_size() {
  if [ -n "$1" ] && [ "$geometry" != "$1" ]; then
    geometry="$1"
    emit "\033]777;archestra-terminal-size=$geometry\007"
  fi
}
while IFS= read -r event; do
  case "$event" in
    archestra-recording-size\ *)
      set -- $event
      pane="$2"
      window="$3"
      record_size "$4"
      touch "$turn.recording-ready"
      ;;
    %layout-change\ *)
      set -- $event
      [ "$2" = "$window" ] || continue
      # Read this pane's leaf, including layouts with other panes in them.
      size="$(printf '%s\n' "$3" | sed -n "s/.*[,{}]\([0-9][0-9]*\)x\([0-9][0-9]*\),[0-9][0-9]*,[0-9][0-9]*,${dollar}{pane#%}\([,}].*\)\{0,1\}\$/\1x\2/p")"
      record_size "$size"
      ;;
    %output\ *)
      output="${dollar}{event#%output }"
      [ "${dollar}{output%% *}" = "$pane" ] || continue
      output="${dollar}{output#* }"
      # tmux escapes controls and every backslash as three octal digits.
      # POSIX printf %b requires a leading zero; decode after substitution so
      # literal backslashes and NUL bytes survive without shell variables.
      output="$(printf '%s' "$output" | sed 's/\\\([0-7][0-7][0-7]\)/\\0\1/g')"
      emit "$output"
      ;;
    %exit) detached=1; break ;;
    %exit*) exit 1 ;;
    %error*) exit 1 ;;
  esac
done
[ "$detached" = 1 ]
`;
}
