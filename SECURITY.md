# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Include what an attacker can do, the steps to reproduce, and the tine version and OS. You will get a reply within a week, and a fix or a plan before anything is disclosed.

## Scope

Reports are most useful about anything that lets untrusted input act on your machine through tine, for example:

- terminal output (escape sequences) that runs commands, opens files or URLs, or fakes shell integration marks;
- a web page in the web panel that reaches tine's commands;
- file names or repository contents that break out of the file tree, viewer or diff;
- the shell integration leaking its secret to child processes.

## Supported versions

Only the latest release receives fixes.
