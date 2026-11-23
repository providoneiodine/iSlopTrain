# Tests

```powershell
node --test
```

Node 18+ and nothing to install. [harness.js](harness.js) loads the real scripts, in `index.html` order, into a sandbox, so a script added to or moved in `index.html` is tested from where it actually loads.

## What belongs here

Tests pin **claims the app makes to the player** that a refactor could quietly break:

- the staircase converges on the threshold it reports,
- the ideal line really is the fastest, every wrong answer really is slower, and the verdict names the mistake that's there,
- Class Traffic's "responsible call" is safe, allowed and fastest under the chosen rules,
- saved history is trimmed only as documented, and a bad import can't wipe it,
- guided sessions only name drills and settings that exist.

Before adding a test, ask what player-visible promise it protects. If the answer is "this function returns this value", leave it out. Don't test drawing, layout or wording, don't assert exact numbers that only reflect today's tuning, and don't loosen or delete a test to make a change pass. Either the change broke a promise, or the promise changed and the test should say the new one.

When a test fails, make sure it would fail for the bug you care about: break the code on purpose and confirm the test catches it.
