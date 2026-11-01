# shellcheck shell=bash
# BASH_ENV of the agent client: each maintained launcher exports it just before
# it starts the client, so it runs in every non-interactive Bash the client
# starts and in nothing that ran before. A shell that runs a command line
# (`bash -c`, `bash -lc`, or commands on its input) is one of the agent's shell
# commands: it takes the highest OOM score, and every process it starts
# inherits that score. On a node that kills one process at a container's memory
# limit (the kubelet's singleProcessOOMKill), the kernel picks the process with
# the highest memory use plus score, so the command is killed before the
# client, its tmux server and PID 1, which keep the container's own score: the
# difference counts as 12.7% of the limit at a score of 873. Bash scripts, such
# as these launchers and their hooks, keep theirs. An unprivileged process may
# raise its own score but never lower it below the container's. Bash skips
# BASH_ENV in an interactive shell, and in a command line whose input is a
# socket while SHLVL is below 1; the image's /etc/bash.bashrc runs this file in
# both. A score of
# 1000 marks a process as one of the agent's commands (README.md, Memory
# limits).
{
  case "${BASH_EXECUTION_STRING:+command}:${0##*/}" in
    command:* | *:bash | *:-bash)
      echo 1000 > "/proc/$$/oom_score_adj"
      ;;
  esac
} 2>/dev/null || :

# The BASH_ENV the client's environment had before the launcher replaced it,
# such as a derived image's own startup file, still runs.
if [ -n "${ARCHESTRA_AGENT_RUNTIME_BASH_ENV:-}" ] \
  && [ "${ARCHESTRA_AGENT_RUNTIME_BASH_ENV}" != "${BASH_SOURCE[0]:-}" ]; then
  # shellcheck source=/dev/null
  . "${ARCHESTRA_AGENT_RUNTIME_BASH_ENV}"
fi
