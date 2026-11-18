# tmux Workspace and Dashboard

Long-running terminal work in the browser: every shell lives in a named tmux session on the host, the **tmux workspace** shows them as tabs that reconnect on their own, and the **Dashboard** lists what is running and which sessions are waiting on you. It was built for running many [Claude Code](https://claude.com/claude-code) sessions on one shared Linux server, one per git repo, and it works the same for any long-running terminal program.

This page is the how-to. The short description is in the [Overview](overview.md#tmux-sessions), the endpoints are in the [API reference](api.md#tmux-sessions).

## What you get

- **Sessions that outlive the browser.** Close the tab, lose the network or put the laptop to sleep: the tmux session only detaches and carries on. Open it again from any device.
- **One browser tab per host**, with a tab inside it for each tmux session, or all of them side by side.
- **Your repos, one click away.** The workspace lists the git repos in a folder of your home directory. A green dot opens the session running in that repo; a black dot starts one there and types your startup command, for example Claude Code named after the repo.
- **A dashboard** of your sessions across hosts: the ones where Claude Code is asking a question or has finished come first, with what it said and a box to answer from the browser, including from a phone.
- **A terminal that behaves**: mouse scrolling inside tmux, copy and paste with the system clipboard, Mac editing keys, and images or files pasted or dropped straight into the terminal.

## The setup in short

1. An SSH entry with **tmux sessions** turned on, with stored credentials.
2. `tmux` (and `git`, for the repo list) on the host.
3. Optional: `[tmux]` in `config.toml` to choose the repos folder and a default startup command.
4. Optional: `[workbench]` to give every member of a Unix group their own folder, entry and key on a shared server.

### 1. Turn tmux on for an SSH entry

On the Connections page, edit an SSH entry (or the SSH protocol of a multi-protocol entry) and tick **tmux sessions**. The entry needs credentials stored in Vault (a password or a private key): listing and starting sessions is a short SSH login made by rustguac, so an entry that prompts for credentials can attach to a session by name but cannot list them.

Everything runs **as the entry's login**. You see that Unix user's tmux sessions and repos, nobody else's. Two people who use the same entry share its sessions, which is also how two people work in one session on purpose.

### 2. The host

- `tmux` installed. Without it the menu says so.
- `git` installed, for the repo list.
- `base64` (coreutils), for startup commands.
- Recommended in `~/.tmux.conf`:

  ```
  set -g mouse on
  set -g history-limit 50000
  ```

  `mouse on` lets the wheel scroll tmux's history and lets programs that ask for the mouse (Claude Code, vim, htop) have it. rustguac turns tmux's `set-clipboard` on itself when it attaches, so a copy made inside tmux or Claude Code reaches your computer's clipboard.

rustguac's guacd build carries two terminal patches that make this work (`patches/012` mouse reporting, `patches/013` OSC 52 copy). The Dockerfile and build scripts apply them; a stock guacd will not scroll or copy inside tmux.

### 3. `[tmux]`: repos folder and default command

```toml
[tmux]
repos_dir = "GitLab"              # ~/GitLab; the default
repo_forge = "git.example.com"    # only repos cloned from this host; default: every repo
repo_command = "claude -n {repo}" # the default startup command for a new repo session
```

- **`repos_dir`**: a folder under each login's home directory. Every git repo below it, up to six levels deep, is listed. Worktrees count. `node_modules`, `vendor` and `.claude` folders are skipped.
- **`repo_forge`**: when set, only repos whose `origin` remote is on that host are listed.
- **`repo_command`**: what is typed into a session started from a repo, until a person sets their own command in the workspace. Placeholders are filled in per repo and quoted for the shell:

  | Placeholder | Is | Example |
  |---|---|---|
  | `{repo}` | the repo folder's name | `website` |
  | `{session}` | the tmux session's name | `website`, or `acme-website` when two repos share a name |
  | `{path}` | the folder on the host | `/home/alice/GitLab/acme/website` |
  | `{rel}` | the folder under `repos_dir` | `acme/website` |

  `claude -n {repo}` starts Claude Code with the session named after the repo, so the repo `acme/website` gets a tmux session `website` running a Claude session called `website`. Other examples: `claude --continue` (pick up the last conversation in that folder), `nvim .`, `git status`.

### 4. `[workbench]`: a personal entry for everyone on a shared server

For a shared Linux server that several people work on. Every member of one Unix group on that host gets, automatically:

- a folder only they can see, titled `Work Bench - <their email>`;
- in it, one SSH entry to the host as **their own Unix user**, with tmux on;
- a key that rustguac generates, keeps in Vault, and installs in their `~/.ssh/authorized_keys`, restricted to the console's address (`from="..."`), so it works only from the console.

Someone who leaves the group loses the folder and the key at the next sync.

```toml
[workbench]
host = "192.0.2.10"
host_label = "bench.example.com"
group = "bench-users"
admin_entry = "shared/servers/bench.example.com"  # scope/folder/entry of a root login
console_from = "198.51.100.7"                     # this console, as the host sees it
email_domain = "example.com"
user_suffix = ""            # Unix user = email local part + this
interval_mins = 15          # sync in the server; 0 = only on demand
```

`rustguac --config config.toml workbench-sync --dry-run` prints what a sync would do; without `--dry-run` it does it. The sync reaches the host with the credentials of `admin_entry`, an entry you already have, so no new secret is configured. Group membership is read on the host (`getent group`), so it follows whatever directory the host uses. `key_marker` (default `rustguac-console`) is the comment that marks the console's keys in `authorized_keys`; only lines carrying it are ever replaced or removed. Do not change it once keys are installed.

The Dashboard uses this section to know which connections are yours (see [Mine and All users](#mine-and-all-users)).

## Using it

### Open the workspace

On the Connections page an entry with tmux on has a **▾** beside **Connect**. It lists the host's tmux sessions, asked of the host each time the menu opens.

- Pick a session to open it, **Open all** for every one, or type a name to attach to it or start it.
- **Connect** itself still opens a plain login shell.
- Sessions open in the **tmux workspace**: one browser tab for the connection. Picking another session later adds a tab to the workspace already open.

**Bookmark the workspace.** Its address always holds the open tabs (`…/tmux.html?…&s=website,api,docs&active=api`), so a bookmark of it, or the browser's "reopen closed tab", brings the whole set back. Tabs connect a few at a time, the active one first, and only the active tab ever takes the keyboard.

### Tabs

- Tabs are all one width and wrap onto more rows when there are many. A long name is cut short; hover for the whole name.
- The dot shows the state: attached, connecting or reconnecting (pulsing), detached, or failed. The tooltip says which.
- **×** or a middle click closes a tab. That only detaches: the tmux session keeps running on the host. rustguac never ends a tmux session; end one from its own shell (`exit`, or `tmux kill-session`).
- **Tabs / Split** switches between one session at a time and every session side by side. In Split, click a pane to type in it.
- **Alt+1** to **Alt+9** switch tabs while the bar has the focus (inside a session, keys go to the session).
- A tab whose connection drops reconnects on its own, waiting longer each time it fails and at once when the browser is back online. If the tmux session itself has ended, the tab says so and offers to start it again.

### + Session: sessions and repos

**+ Session** opens a list with one search box for both halves:

- **Sessions**: the running tmux sessions of this login, with the repo each is in, how many clients are attached and when it was last active.
- **Repos**: every repo under the repos folder.
  - **Green dot**: a tmux session is running in that folder. Click to open it.
  - **Black dot**: none. Click to start one in that folder, named after the repo, and open it.
- **Run in a new repo session**: the startup command typed into a session started from a black dot. It shows the console's default until you type your own; yours is remembered in that browser. Empty means run nothing. **Default** goes back to the console's command. The placeholders above work here too.
- The box at the bottom opens or starts a session by name, in the home directory, with no command.

Type a few letters and press **Enter** to open the first match.

### The Dashboard

**Dashboard** in the navigation (operator role and up) asks each of your hosts once and refreshes every 30 seconds while the page is showing.

- **Waiting on you**: sessions where Claude Code is asking something (a permission or a choice) come first, then the ones that have finished and wait for your next message. Each card shows the end of what Claude said. For a numbered prompt there is a button per choice; the box sends a typed answer. **Open** goes to the session in the workspace.
- **Working**: sessions where Claude Code is busy.
- **Other sessions**: everything else, with the program running in each.
- **Repos**: the same green and black dots; **Start** begins a session in the repo with your startup command and opens it.
- **Open all** opens every running session shown, as tabs of each host's workspace. It never starts sessions for repos that have none. With more than one host the browser may block the extra windows until you allow pop-ups for the site.

Claude Code's state is read off the visible screen of the session's active pane, so it is a good guess, not a guarantee. An answer sent from the dashboard is typed into the session exactly as if you had typed it there. The audit log records who sent an answer, to which session and how long it was, never its text.

#### Mine and All users

A selector at the top chooses whose sessions are shown:

- **Mine** (the default): only your own. With `[workbench]` configured, that is the connection in your own work bench folder. If you have no work bench folder, it is the work bench host's entries that are not in someone else's work bench folder. Without `[workbench]`, every tmux connection you can open counts as yours.
- **All users**: every tmux connection you are allowed to open. For an admin that includes everyone's work bench, and each session says whose login it runs under. The choice is remembered in the browser.

The host chips beside the selector switch single hosts off and on. The selector is hidden when there is nothing but your own to show. It never shows more than your access to folders and entries already allows.

### Several sessions at once, and presets

**Advanced**, at the bottom of the ▾ menu, starts a batch: one row per session with a name, an optional starting folder and commands to type once its shell is up. **Edit as text** takes a pasted list, one session per line:

```
website @~/GitLab/acme/website "claude --continue"
api: cd ~/GitLab/acme/api; make dev
logs "journalctl -f"
```

A session that is already running is left exactly as it is and nothing is typed into it. A batch can be saved as a **preset**, which then appears in the ▾ menu and starts with one click. Presets are stored per user and per entry, and hold commands as typed, so keep secrets out of them.

### In the terminal

| To | Do |
|---|---|
| Scroll back | Mouse wheel (with `set -g mouse on` in tmux) |
| Select text for the system clipboard when a program has the mouse | Hold **Shift** and drag |
| Copy | Select with the mouse, or copy inside tmux / Claude Code; on a Mac **Cmd+C** |
| Paste text | **Ctrl+Shift+V**, **Cmd+V** on a Mac, or right-click |
| Paste an image | **Ctrl+V** (or **Cmd+V** with an image on the clipboard) |
| Attach a file | Drag it onto the terminal |
| New line without sending (Claude Code) | **Shift+Enter** |
| Start / end of line (Mac) | **Cmd+Left** / **Cmd+Right** |
| Word back / forward (Mac) | **Option+Left** / **Option+Right** |
| Delete to line start / delete word (Mac) | **Cmd+Backspace** / **Option+Backspace** |

A pasted image or dropped file is saved on the host, as your login, under `~/.cache/console-uploads/`, and its path is typed into the terminal. Claude Code takes a pasted image path as an attachment. Files are at most 32 MB and are removed after seven days.

## A worked example

A team shares one Linux server. Each person's repos are cloned under `~/GitLab/<group>/<repo>`, and each repo has its own Claude Code session.

1. The admin adds `[workbench]` and this to `config.toml`:

   ```toml
   [tmux]
   repo_command = "claude -n {repo}"
   ```

2. Each person signs in, opens **Dashboard**, and under **Repos** presses **Start** on the repos they are working in. Each gets a tmux session named after the repo, in the repo's folder, running Claude Code named after the repo.
3. **Open all** puts every session into one workspace window. They bookmark it.
4. During the day the Dashboard, on the desktop or a phone, shows which sessions are waiting. Quick answers go from the card; anything longer, **Open**.
5. Next morning the bookmark reopens every tab. The sessions never stopped.

## Security notes

- Listing, starting and answering are SSH logins as the entry's own user, with the entry's stored credentials, through its jump hosts. They show in the host's auth log.
- Session names are limited to `A-Z a-z 0-9 _ - @ + = , ~` and checked on the server before any command is built. Startup commands travel base64-encoded and are typed only into sessions that the same request created.
- Starting sessions, answers sent from the dashboard and uploads are written to rustguac's audit log.
- A startup command is run by the person's own login on the host. It gives no access they did not already have through the entry.
- Work bench keys are restricted with `from=` to the console's address.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The ▾ menu says tmux is not installed | Install `tmux` on the host. |
| "No stored credentials" | The entry prompts for credentials. Store a password or key on the entry to list and start sessions. |
| No repos listed | Check `repos_dir`, that `git` is installed on the host, and `repo_forge` if set (the repo's `origin` must be on that host). |
| The wheel does not scroll in tmux | `set -g mouse on` in `~/.tmux.conf`, and a guacd built with rustguac's patches. |
| Copy inside tmux does not reach the clipboard | The browser must allow clipboard access for the site, and guacd must be built with rustguac's patches. |
| Open all opens only one window | The browser blocked the others. Allow pop-ups for the site. |
| A session started without its command | The session already existed (nothing is typed into a running session), or the host has no `base64`. |
| The work bench sync does nothing | Run `workbench-sync --dry-run`: it prints why (`email_domain` missing, `admin_entry` not found, the group has no members). |
