---
name: verify
description: Smoke-test a change to Safari Harness before committing it or calling it done. Runs the tests that cover the changed files, boots this checkout's daemon on its own ports, drives real Safari through this checkout's CLI in one background tab, and says whether the live daemon runs the changed code.
---

# Verify a Safari Harness change

The harness in use runs from a release (`~/.local/share/safari-harness/current`), never from a checkout. An edit here reaches no one until it is committed and deployed, and only Aktan approves a deploy.

## Run

From the checkout's root:

```sh
bun .claude/skills/verify/verify.ts                 # changes against origin/master
bun .claude/skills/verify/verify.ts --base HEAD~1   # another base
bun .claude/skills/verify/verify.ts daemon/guard.ts # count a file as changed
```

It took 2 s on 11-16 with no test file picked; each test file adds its own time, and a busy Safari adds more. It:

1. Lists the changed files: commits since the base, uncommitted edits and new files.
2. Runs `bun install --frozen-lockfile` if `node_modules` is missing.
3. Runs `bun test ./<file>` for every test that names a changed file in quotes, one process per file, four at a time. Any `extension/*.js` change adds `bench/*.test.ts`. Any `docs/` change adds `daemon/guides.test.ts`.
4. Compares this checkout's daemon code hash (`daemon/codehash.ts`) with the live daemon's (`/health` on 127.0.0.1:37334). It diffs `extension/`, `Safari Harness/` and `omp/` against the live release when they changed.
5. Starts this checkout's daemon on free ports with `HOME` set to a scratch folder, joins `scripts/fake-extension.ts` to it, and opens, reads and closes a tab through this checkout's CLI. This shows the changed daemon starts and answers. It does not touch Safari.
6. Serves a local page and drives the live daemon through this checkout's CLI: `open --bg`, `snapshot`, `click`, `eval`, `close`. The tab opens in the background.
7. Closes any tab on its page that the CLI left, through the live daemon's `/rpc` rather than this checkout's CLI. Then it checks that none is left, that Safari did not come forward because of the run, and that the live daemon has the same pid and code as at the start.

## Pass

The last line is `ALL PASSED` and the exit status is 0. Every `FAIL` line shows what came back.

Then read the `LIVE:` and `NOT LIVE:` lines and repeat them in your report:

- `LIVE: the running daemon runs this checkout's daemon code`: step 6 exercised the daemon code as it is here.
- `NOT LIVE: ... daemon ...`: step 6 ran the deployed daemon, not your change. Your daemon change is proven only by the tests and step 5.
- `NOT LIVE: ... extension ...` or `... omp ...`: no step ran the changed extension or omp extension. Say so.
- Code under `cli/` always runs from this checkout, so step 6 exercises it.

A `FAIL` that says `timed out`, `stuck` or `no page loaded` can come from Safari being slow, not from your change. Other agents use the same Safari. Check `tail -20 ~/Library/Logs/safari-harness/journal-37334.jsonl`. `slow-phase` lines for `tabs.query` that took seconds mean Safari is overloaded. Wait a few minutes and run once more. If it fails again, report the check as not verified.

## Never

- Never deploy (`scripts/dev-install.sh`) without Aktan's explicit yes. A deploy of an unmerged branch blocks every later deploy of master until that branch is merged.
- Never run `scripts/check-live.ts --restart`, `--before-install` or `--after-install`, `scripts/check-pairing.ts`, `safari extension reload`, or POST to `/shutdown`. Each one restarts or reloads the harness everyone shares.
- Never run `bun scripts/check-live.ts` (`bun run check`) to check a change that is not deployed. It tests the deployed release, not this checkout. It also brings Safari forward, resizes a window and runs a handoff self-test.

## After Aktan approves a deploy

1. Run `safari agents`. If another agent is working in Safari, wait until it is idle.
2. Deploy with `scripts/dev-install.sh`. Run `safari status`: its `code` must equal `bun daemon/codehash.ts`.
3. Run `bun scripts/check-live.ts`. Pass: exit status 0 and no `FAIL` lines.
4. If it fails, roll back with `scripts/dev-install.sh --rollback` and report what failed.

## Clean up

The script closes its tab and stops its page server, its own daemon and its fake extension. It also deletes its scratch folder in `/private/var/tmp/safari-verify-*`. To confirm, run:

```sh
ps -axo pid,command | grep -E 'fake-extension|daemon/main.ts' | grep -v grep
ls -d /private/var/tmp/safari-verify-* 2>/dev/null
```

Only the launchd daemon should be listed, and its path should be under `.local/share/safari-harness/releases/`. No scratch folder should be left.

## Not covered

- Swift helpers (`scripts/*.swift`): the script hashes them, but it does not build them. Building takes `bun run helpers`, and running them needs Accessibility permission.
- What only real Safari shows (timers in a background tab, frames, focus) when the change is not deployed.
