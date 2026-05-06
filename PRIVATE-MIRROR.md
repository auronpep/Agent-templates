# Private Mirror: Agent-templates

This repository is the private VoteWood/Agent-templates mirror of https://github.com/davila7/claude-code-templates.

## Remotes

- origin: private GitHub repo, push target, https://github.com/VoteWood/Agent-templates.git
- upstream: public source repo, fetch only, https://github.com/davila7/claude-code-templates
- Upstream default branch: main
- Private working branch: main

## Update

Use the local helper:

git update-main

That fetches upstream/main, fast-forwards private main, and
pushes only to private origin.

## Safety

This mirror has local guardrails to block pushes to the public upstream:

- upstream has its push URL set to DISABLED_PUSH_TO_PUBLIC_UPSTREAM.
- Local pushInsteadOf rules rewrite direct public upstream pushes to the same
  disabled URL.
- remote.pushDefault and branch.main.pushRemote point to origin.
- .githooks/pre-push blocks upstream/public push targets before Git sends
  objects.