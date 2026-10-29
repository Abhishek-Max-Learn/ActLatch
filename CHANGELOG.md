# Changelog

Every release of Act-Latch, newest first. Version numbers follow [semantic versioning](https://semver.org):
the last number goes up for fixes, the middle one for new features, the first one for changes that can break an
existing setup. While it starts with `0.`, Act-Latch is still early and the middle number may also carry such changes.

## 0.1.0 (not released yet)

First release.

- MCP gateway: the agent connects to Act-Latch instead of the real tool servers; credentials stay in the gateway.
- Policy rules (allow, ask a human, block) with conditions on recipient count, outside addresses, text patterns and
  numeric limits, including limits checked against real looked-up values.
- Agent registry: which agent may use which tool, read/write/update/delete types.
- Agent-to-agent hand-offs: only the agent marked `orchestrator: true` may pass work to other agents; helpers never
  see hand-off tools and are blocked if they try. The orchestrator's hand-offs need a human unless the pair is allowed.
- Prompt-injection guard: after reading untrusted content, protected tools need a human; injected text can never
  grant permissions.
- Local approval page with pop-up cards, plain-words preview and automatic block on timeout.
- Hash-chained audit log, readable with `actlatch log`.
- Guided setup (`actlatch setup`) and a security review of risky setups (`actlatch review`).
- Configuration guide (`docs/CONFIGURATION.md`) and security design (`docs/SECURITY-DESIGN.md`).
- Several agents can share one approval page (`ACTLATCH_APPROVAL_TOKEN`), and an app can show the page at its own
  address (`ACTLATCH_APPROVAL_URL` or `approval.publicUrl`), for example on a free cloud host with one public address.
- Security hardening from a code scan: recipient and pattern rules cannot be dodged by reformatting arguments,
  approval page security headers, private audit log file.
