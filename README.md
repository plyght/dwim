# dwim

Shell-agnostic overlay for native commands and natural-language intents on one line.

```sh
bun install
bun run dev
```

Use normal commands as usual. Natural language is routed to the brain and returns an editable proposal.

Overrides:
- `!!fix the last failure` forces intent.
- `::Show` forces shell command.

Quality gates:

```sh
bun run check
```

Optional config lives at `~/.dwim/config.json`:

```json
{
	"proposalUx": "inline",
	"destructiveGuard": false,
	"confirmAll": false,
	"provider": "anthropic",
	"model": "claude-sonnet-4-5-20250929",
	"plugins": []
}
```

Plugin docs: `docs/plugins.md`.
