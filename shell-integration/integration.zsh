# tine shell integration for zsh. tine starts zsh with ZDOTDIR pointing at a folder
# where this file is installed as .zshenv; it hands ZDOTDIR back to the user's
# config, so zsh then reads the user's own .zprofile, .zshrc and .zlogin as usual.

# Signs tine's marks; kept unexported so programs run here cannot forge them.
typeset -g __tine_token=${TINE_TOKEN-}
unset TINE_TOKEN

if [[ -n ${TINE_USER_ZDOTDIR+x} ]]; then
  ZDOTDIR=$TINE_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset TINE_USER_ZDOTDIR

[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

if [[ -o interactive ]]; then
  # Marks for tine: OSC 7 reports the working directory; OSC 133 marks prompt (A),
  # command start (C) and command end with its exit code (D); OSC 633;E carries the
  # command line, percent-encoded so control characters cannot end the sequence early.
  __tine_ran=
  __tine_precmd() {
    local ret=$?
    [[ -n $__tine_ran ]] && printf '\e]133;D;%s;tine=%s\a' "$ret" "$__tine_token"
    __tine_ran=
    printf '\e]133;A;tine=%s\a' "$__tine_token"
    printf '\e]7;file://%s%s\e\\' "$HOST" "${PWD//\%/%25}"
  }
  __tine_preexec() {
    local cmd=${1//\%/%25}
    cmd=${cmd//$'\n'/%0A}
    cmd=${cmd//$'\a'/%07}
    cmd=${cmd//$'\e'/%1B}
    cmd=${cmd//;/%3B}
    printf '\e]633;E;%s;tine=%s\a\e]133;C;tine=%s\a' "$cmd" "$__tine_token" "$__tine_token"
    __tine_ran=1
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec __tine_preexec
  # First in line, so $? is still the command's exit code.
  precmd_functions=(__tine_precmd ${precmd_functions[@]})
fi
