# tine shell integration for zsh. tine starts zsh with ZDOTDIR pointing at a folder
# where this file is installed as .zshenv; it hands ZDOTDIR back to the user's
# config, so zsh then reads the user's own .zprofile, .zshrc and .zlogin as usual.

if [[ -n ${TINE_USER_ZDOTDIR+x} ]]; then
  ZDOTDIR=$TINE_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset TINE_USER_ZDOTDIR

[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

if [[ -o interactive ]]; then
  # OSC 7: report the working directory so tine's file tree can follow it.
  __tine_osc7() { printf '\e]7;file://%s%s\e\\' "$HOST" "${PWD//\%/%25}" }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __tine_osc7
fi
