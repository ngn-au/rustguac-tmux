# guacd terminal tests (patches 012 and 013)

Drives the patched guacd over the Guacamole protocol against a local sshd
whose login shell (`app.sh`) sets up what a program in tmux would and records
its raw input.

```sh
docker build --target guacd-builder -t rg-guacd-check .
docker run --rm -v "$PWD/tests/guacd-mouse":/work:ro rg-guacd-check sh /work/run.sh
```

Expected:
- **app on, client mouse** (mouse tracking on, as tmux does for Claude Code): `ESC[<35;10;5M` (motion),
  `ESC[<64;…M` / `ESC[<65;…M` (wheel), `ESC[<0;…M` + `ESC[<0;…m` (left click), then `x`.
- **app off, client mouse**: only `x` (the wheel stays local).
- **app osc52, client osc52**: the client prints `clipboard from guacd: hello-osc52` (OSC 52 reached
  the browser side), and the right click is not reported but pastes it locally: the app receives
  `hello-osc52` then `x`.
- **app off, client stdin**: `pasted\rline2` then `x` (the STDIN pipe stream that Cmd+V uses).
