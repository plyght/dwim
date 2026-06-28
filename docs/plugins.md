# dwiw plugin API

Plugins are ESM modules exporting `default` or `plugin` with this shape:

```ts
export default {
  name: "my-plugin",
  injectContext(context) {},
  observeShellEvent(event) {},
  postProcessProposal(command) { return command; },
};
```

Load plugins with `DWIW_PLUGINS=/absolute/plugin-a.ts:/absolute/plugin-b.ts dwiw`.

Built-ins:
- `shell-context`: injects cwd, recent history, redacted/capped last output.
- `memory`: stores explicit `remember ...` facts in `~/.dwiw/memory.json`.
