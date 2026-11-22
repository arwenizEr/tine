# tine shell integration for bash, loaded with `bash --rcfile <this> -i`.
# --rcfile only works for non-login shells, so this file does the login startup
# itself: /etc/profile, then the first of ~/.bash_profile, ~/.bash_login, ~/.profile.

[ -r /etc/profile ] && . /etc/profile
for __tine_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__tine_f" ]; then . "$__tine_f"; break; fi
done
unset __tine_f

# OSC 7: report the working directory so tine's file tree can follow it.
__tine_osc7() { printf '\e]7;file://%s%s\e\\' "$HOSTNAME" "${PWD//\%/%25}"; }
PROMPT_COMMAND="__tine_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
