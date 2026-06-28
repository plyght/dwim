dwiw

hey computer: Do What I Want!

Shell-agnostic overlay for native commands and natural-language intents on one line. Commands run as commands. Requests become editable proposals before execution.

Install:

    bun install

Run:

    bun run dev

Use:

    ls src
    fix the last failure
    !!fix the last failure
    ::show current directory

Prefixes:

    !!    force natural-language intent
    ::    force shell command

Check:

    bun run check

Config:

    ~/.dwiw/config.json

Example:

    {
      "proposalUx": "inline",
      "destructiveGuard": false,
      "confirmAll": false,
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "plugins": []
    }

Plugin docs:

    docs/plugins.md
