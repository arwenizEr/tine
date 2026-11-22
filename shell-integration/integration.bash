# tine shell integration for bash, loaded with `bash --rcfile <this> -i`.
# --rcfile only works for non-login shells, so this file does the login startup
# itself: /etc/profile, then the first of ~/.bash_profile, ~/.bash_login, ~/.profile.

# Signs tine's marks; kept unexported so programs run here cannot forge them.
__tine_token=${TINE_TOKEN-}
unset TINE_TOKEN

[ -r /etc/profile ] && . /etc/profile
for __tine_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__tine_f" ]; then . "$__tine_f"; break; fi
done
unset __tine_f

# Marks for tine: OSC 7 reports the working directory; OSC 133 marks prompt (A),
# command start (C) and command end with its exit code (D); OSC 633;E carries the
# command line, percent-encoded so control characters cannot end the sequence early.
__tine_ran=
__tine_armed=
__tine_pre() {
  local ret=$?
  [ -n "$__tine_ran" ] && printf '\e]133;D;%s;tine=%s\a' "$ret" "$__tine_token"
  __tine_ran=
  printf '\e]133;A;tine=%s\a' "$__tine_token"
  printf '\e]7;file://%s%s\e\\' "$HOSTNAME" "${PWD//\%/%25}"
}
# Runs last in PROMPT_COMMAND: the next DEBUG trap is the user's own command.
__tine_arm() { __tine_armed=1; }
__tine_debug() {
  [ -n "$__tine_armed" ] || return 0
  __tine_armed=
  local cmd
  cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
  cmd=${cmd//\%/%25}
  cmd=${cmd//$'\a'/%07}
  cmd=${cmd//$'\e'/%1B}
  cmd=${cmd//;/%3B}
  printf '\e]633;E;%s;tine=%s\a\e]133;C;tine=%s\a' "$cmd" "$__tine_token" "$__tine_token"
  __tine_ran=1
}
PROMPT_COMMAND="__tine_pre${PROMPT_COMMAND:+;$PROMPT_COMMAND};__tine_arm"
# Never replace a DEBUG trap the user set up themselves; blocks are then simply off.
[ -z "$(trap -p DEBUG)" ] && trap '__tine_debug' DEBUG
