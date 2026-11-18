//! Named tmux sessions on an SSH entry's host (#325).
//!
//! An SSH protocol with `tmux: true` can attach to a named tmux session on
//! the host instead of opening a plain login shell. The shell then lives on
//! the host: closing the tab, losing the network or ending the rustguac
//! session only detaches, and connecting again with the same name picks up
//! where it was.
//!
//! The attach is guacd's SSH `command` parameter, so guacd still owns the
//! terminal: `tmux new-session -A -s <name>` attaches when the session
//! exists and creates it otherwise. Listing sessions, and starting a batch
//! of them with startup commands typed in ([`start_command`]), is a short
//! SSH exec of its own from rustguac (`crate::tunnel::run_command`), with
//! the entry's stored credentials, run only when the user asks. rustguac
//! never ends a tmux session: that is done from the session's own shell.
//!
//! Every command is run under `sh -c`, so the user's login shell (bash, zsh,
//! fish, ...) only has to understand one single-quoted word. Session names
//! are restricted to [`valid_name`]'s characters, none of which a shell
//! treats specially, and are checked again here before any command is
//! built.

use serde::{Deserialize, Serialize};

/// Longest session name accepted.
pub const MAX_NAME_LEN: usize = 64;

/// Printed by the list and start commands when tmux is not installed.
const NOT_INSTALLED_MARK: &str = "@@rustguac-no-tmux";
/// Printed after the listing, so a listing cut short is not read as empty.
const DONE_MARK: &str = "@@rustguac-done";

/// Whether `name` may name a tmux session: 1 to [`MAX_NAME_LEN`] of
/// `A-Z a-z 0-9 _ - @ + = , ~`. tmux itself refuses `.` and `:`, and none of
/// these mean anything to a shell, inside double quotes or out.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-@+=,~".contains(&b))
}

/// The error for a name [`valid_name`] refuses.
pub fn name_error() -> String {
    format!(
        "tmux session names are 1 to {MAX_NAME_LEN} characters: letters, digits and _ - @ + = , ~"
    )
}

/// `sh -c '<script>'`, for a script with no single quotes in it.
fn sh(script: &str) -> String {
    debug_assert!(!script.contains('\''));
    format!("sh -c '{script}'")
}

/// The command guacd runs instead of a login shell: attach to the tmux
/// session `name`, creating it if it does not exist. Without tmux on the
/// host the terminal says so and waits for Enter, rather than the
/// connection just closing. `None` for an invalid name.
pub fn attach_command(name: &str) -> Option<String> {
    if !valid_name(name) {
        return None;
    }
    // -u: the host may not pass guacd's locale on, and tmux falls back to
    // ASCII line drawing without a UTF-8 one. set-clipboard on: tmux passes
    // a program's own OSC 52 copy (Claude Code, vim) on to the console,
    // which puts it on the browser's clipboard; tmux's default,
    // `external`, drops it.
    Some(sh(&format!(
        "if command -v tmux >/dev/null 2>&1; then exec tmux -u new-session -A -s \"{name}\" \\; set-option -s set-clipboard on; fi; \
         printf \"\\nrustguac: tmux is not installed on this host, so the tmux session {name} cannot be opened.\\n\
         Install tmux, or connect without a tmux session.\\n\\nPress Enter to close. \"; read _"
    )))
}

/// Prefix of the line [`list_command`] prints before the sessions: the
/// login, `@@rgsrv <user>`.
const SERVER_MARK: &str = "@@rgsrv";

/// `tmux list-sessions` with the fields [`parse_listing`] reads, on the
/// login's default server. Fields are split on `:`, which tmux refuses in a
/// session name (it also turns a tab into `_` in its output, so a tab will
/// not do). The folder may hold `:`, so it comes last and keeps the rest of
/// the line.
const LIST_SESSIONS: &str = "tmux list-sessions -F \"#{session_name}:#{session_attached}:#{session_windows}:#{session_created}:#{session_activity}:#{session_path}\" 2>/dev/null";

/// The command that lists the host's tmux sessions, read by
/// [`parse_listing`].
///
/// Scope: only the login's own tmux server is asked, never another
/// user's socket, so an entry sees exactly its login's sessions. Root sees
/// root's. The login's name is printed first so the page can say whose
/// sessions these are.
pub fn list_command() -> String {
    // No server running is not an error here: it is a host with no
    // sessions, so tmux's complaint is discarded and the listing is empty.
    sh(&format!(
        "command -v tmux >/dev/null 2>&1 || {{ echo {NOT_INSTALLED_MARK}; exit 0; }}; \
         echo \"{SERVER_MARK} $(id -un)\"; {LIST_SESSIONS}; echo {DONE_MARK}"
    ))
}

/// Whether the output of [`list_command`] or [`start_command`] says tmux is
/// missing.
pub fn reports_not_installed(stdout: &str) -> bool {
    stdout.lines().any(|l| l.trim() == NOT_INSTALLED_MARK)
}

/// Most sessions one start may ask for.
pub const MAX_START: usize = 20;
/// Longest starting folder accepted.
pub const MAX_DIR_LEN: usize = 1024;
/// Longest startup commands accepted, per session.
pub const MAX_COMMANDS_LEN: usize = 8192;

/// Printed by [`start_command`] when the host has no `base64`.
const NO_BASE64_MARK: &str = "@@rustguac-no-base64";
/// Prefix of [`start_command`]'s per-session lines: `@@rg <state> <name>`.
const START_MARK: &str = "@@rg";

/// One session to start: a name, the folder it starts in, and the commands
/// typed into its shell once it is up. Startup commands are only ever typed
/// into a session this start created: one that is already running is left
/// alone.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct StartSpec {
    pub name: String,
    /// Starting folder; empty for the login's home. `~` and `~/...` are the
    /// login's home.
    #[serde(default)]
    pub dir: String,
    /// Typed into the new session's shell, then Enter. Empty for none.
    #[serde(default)]
    pub commands: String,
}

/// Why a list of [`StartSpec`]s cannot be started, if it cannot.
pub fn check_specs(specs: &[StartSpec]) -> Result<(), String> {
    if specs.is_empty() {
        return Err("no sessions to start".into());
    }
    if specs.len() > MAX_START {
        return Err(format!(
            "at most {MAX_START} sessions can be started at once"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for s in specs {
        if !valid_name(&s.name) {
            return Err(format!("{:?}: {}", s.name, name_error()));
        }
        if !seen.insert(s.name.as_str()) {
            return Err(format!("{} is listed twice", s.name));
        }
        if s.dir.len() > MAX_DIR_LEN || s.dir.contains(['\0', '\n', '\r']) {
            return Err(format!("{}: the folder is not a usable path", s.name));
        }
        if s.commands.len() > MAX_COMMANDS_LEN || s.commands.contains('\0') {
            return Err(format!(
                "{}: startup commands are at most {MAX_COMMANDS_LEN} characters",
                s.name
            ));
        }
    }
    Ok(())
}

/// The command that starts each session in `specs` that is not already
/// running, then types its startup commands into it. Read by
/// [`parse_start`]. `None` when [`check_specs`] refuses `specs`.
///
/// Folders and commands go over as base64 and are decoded on the host, so
/// no quoting of the user's text is involved at all: the script only ever
/// sees `[A-Za-z0-9+/=]`. All the sessions are created before any command is
/// typed, and each command waits (up to 4 s) for the new shell to print its
/// prompt first, as some shells drop typeahead that arrives sooner. The
/// commands are typed rather than given to tmux as the session's command,
/// so the session outlives them: when they exit, the shell is still there.
pub fn start_command(specs: &[StartSpec]) -> Option<String> {
    use base64::Engine;
    check_specs(specs).ok()?;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    let mut script = format!(
        "command -v tmux >/dev/null 2>&1 || {{ echo {NOT_INSTALLED_MARK}; exit 0; }}; \
         command -v base64 >/dev/null 2>&1 || {{ echo {NO_BASE64_MARK}; exit 0; }}; \
         rg_new() {{ \
           if tmux has-session -t \"=$1\" 2>/dev/null; then echo \"{START_MARK} running $1\"; return 1; fi; \
           d=$(printf %s \"$2\" | base64 -d); \
           case \"$d\" in \"~\") d=\"$HOME\";; \"~/\"*) d=\"$HOME/${{d#\"~/\"}}\";; esac; \
           if [ -n \"$d\" ] && [ ! -d \"$d\" ]; then echo \"{START_MARK} no_dir $1\"; return 1; fi; \
           if [ -n \"$d\" ]; then tmux new-session -d -s \"$1\" -c \"$d\"; else tmux new-session -d -s \"$1\"; fi \
             || {{ echo \"{START_MARK} failed $1\"; return 1; }}; \
           echo \"{START_MARK} created $1\"; }}; \
         rg_keys() {{ \
           c=$(printf %s \"$2\" | base64 -d); [ -n \"$c\" ] || return 0; \
           i=0; while [ $i -lt 40 ] && ! tmux capture-pane -p -t \"=$1:\" 2>/dev/null | grep -q .; do \
             sleep 0.1 2>/dev/null || sleep 1; i=$((i+1)); done; \
           tmux send-keys -t \"=$1:\" -l -- \"$c\" && tmux send-keys -t \"=$1:\" Enter \
             && echo \"{START_MARK} sent $1\"; }}; "
    );
    for (i, s) in specs.iter().enumerate() {
        script.push_str(&format!(
            "rg_new \"{}\" \"{}\" && m{i}=1; ",
            s.name,
            b64(&s.dir)
        ));
    }
    for (i, s) in specs.iter().enumerate() {
        if !s.commands.is_empty() {
            script.push_str(&format!(
                "[ -n \"$m{i}\" ] && rg_keys \"{}\" \"{}\"; ",
                s.name,
                b64(&s.commands)
            ));
        }
    }
    script.push_str(&format!("echo {DONE_MARK}"));
    Some(sh(&script))
}

/// What happened to one session of a start.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartedSession {
    pub name: String,
    /// `created`, `running` (it already was, so nothing was typed into it),
    /// `no_dir` (the folder does not exist on the host) or `failed`.
    pub state: String,
    /// Whether its startup commands were typed in.
    pub commands_sent: bool,
}

/// What a host said about a start.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartOutcome {
    pub installed: bool,
    /// The host has tmux but no `base64` to read the commands with.
    pub no_base64: bool,
    /// In the order asked for.
    pub sessions: Vec<StartedSession>,
}

/// Read the output of [`start_command`] for `specs`. `None` when it is not
/// that output (cut short, or the login printed something else instead).
pub fn parse_start(stdout: &str, specs: &[StartSpec]) -> Option<StartOutcome> {
    let missing = |no_base64| StartOutcome {
        installed: no_base64,
        no_base64,
        sessions: Vec::new(),
    };
    if reports_not_installed(stdout) {
        return Some(missing(false));
    }
    if stdout.lines().any(|l| l.trim() == NO_BASE64_MARK) {
        return Some(missing(true));
    }
    let mut sessions: Vec<StartedSession> = specs
        .iter()
        .map(|s| StartedSession {
            name: s.name.clone(),
            state: "failed".into(),
            commands_sent: false,
        })
        .collect();
    let mut done = false;
    for line in stdout.lines() {
        let line = line.trim();
        if line == DONE_MARK {
            done = true;
            break;
        }
        let mut f = line.split(' ');
        if f.next() != Some(START_MARK) {
            continue;
        }
        let (Some(state), Some(name), None) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let Some(s) = sessions.iter_mut().find(|s| s.name == name) else {
            continue;
        };
        match state {
            "sent" => s.commands_sent = true,
            "created" | "running" | "no_dir" | "failed" => s.state = state.into(),
            _ => {}
        }
    }
    done.then_some(StartOutcome {
        installed: true,
        no_base64: false,
        sessions,
    })
}

/// One tmux session on a host.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmuxSession {
    pub name: String,
    /// How many clients are attached to it now.
    pub attached: u32,
    pub windows: u32,
    /// Unix seconds.
    pub created: Option<i64>,
    /// Unix seconds of the last input or output.
    pub activity: Option<i64>,
    /// Whether rustguac can attach to it: its name passes [`valid_name`].
    /// Sessions named outside that set are listed but not offered.
    pub attachable: bool,
    /// The folder it was started in (`session_path`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The command in its active pane (dashboard only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Its active pane's title; Claude Code puts the task name there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What Claude Code in its active pane is doing, read off the screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude: Option<ClaudeState>,
}

/// What a host said about its tmux sessions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmuxListing {
    /// Whether tmux is installed on the host.
    pub installed: bool,
    /// The user the entry logged in as, when the host said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// Most recently active first.
    pub sessions: Vec<TmuxSession>,
}

/// Read the output of [`list_command`]. `None` when it is not that output
/// (cut short, or the login printed something else instead).
pub fn parse_listing(stdout: &str) -> Option<TmuxListing> {
    if reports_not_installed(stdout) {
        return Some(TmuxListing {
            installed: false,
            login: None,
            sessions: Vec::new(),
        });
    }
    let mut sessions = Vec::new();
    let mut login: Option<String> = None;
    let mut done = false;
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim() == DONE_MARK {
            done = true;
            break;
        }
        if let Some(o) = line
            .strip_prefix(SERVER_MARK)
            .and_then(|r| r.strip_prefix(' '))
        {
            login.get_or_insert_with(|| o.trim().to_string());
            continue;
        }
        let f: Vec<&str> = line.splitn(6, ':').collect();
        // A banner or motd from the login shell is not a session.
        if f.len() != 6 || f[0].is_empty() || !f[1..5].iter().all(|n| n.parse::<i64>().is_ok()) {
            continue;
        }
        sessions.push(TmuxSession {
            name: f[0].to_string(),
            attached: f[1].parse().unwrap_or(0),
            windows: f[2].parse().unwrap_or(0),
            created: f[3].parse().ok(),
            activity: f[4].parse().ok(),
            attachable: valid_name(f[0]),
            path: Some(f[5].to_string()).filter(|p| !p.is_empty()),
            command: None,
            title: None,
            claude: None,
        });
    }
    if !done {
        return None;
    }
    sessions.sort_by(|a, b| b.activity.cmp(&a.activity).then(a.name.cmp(&b.name)));
    Some(TmuxListing {
        installed: true,
        login,
        sessions,
    })
}

// ── Repos under the login's repos folder ──

/// Prefix of [`repos_command`]'s line naming the folder scanned.
const ROOT_MARK: &str = "@@rgroot";
/// Prefix of [`repos_command`]'s line per repo: `@@rgrepo <path>`.
const REPO_MARK: &str = "@@rgrepo";

/// `[tmux]` in config.toml: the repo list of the tmux workspace and the
/// dashboard.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TmuxConfig {
    /// The folder under each login's home whose git repos are listed.
    /// Default: `GitLab` (`~/GitLab`).
    #[serde(default = "default_repos_dir")]
    pub repos_dir: String,
    /// List only repos whose `origin` is on this host (`git.example.com`).
    /// Default: empty, every git repo found.
    #[serde(default)]
    pub repo_forge: String,
    /// The startup command offered for a session started in a repo, until
    /// the person sets their own. `{repo}` is the repo folder's name,
    /// `{session}` the tmux session's, `{path}` the folder and `{rel}` the
    /// folder under `repos_dir` (the pages fill these in). For example
    /// `claude -n {repo}`. Default: none.
    #[serde(default)]
    pub repo_command: String,
}

fn default_repos_dir() -> String {
    "GitLab".into()
}

impl Default for TmuxConfig {
    fn default() -> Self {
        Self {
            repos_dir: default_repos_dir(),
            repo_forge: String::new(),
            repo_command: String::new(),
        }
    }
}

impl TmuxConfig {
    /// Why this config cannot be used, if it cannot. `repos_dir` and
    /// `repo_forge` become part of a shell script, so only characters no
    /// shell treats specially are accepted.
    pub fn check(&self) -> Result<(), String> {
        let plain = |s: &str, extra: &[u8]| {
            s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b) || extra.contains(&b))
        };
        let d = &self.repos_dir;
        if d.is_empty()
            || !plain(d, b"/")
            || d.starts_with(['/', '-'])
            || d.split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!(
                "[tmux] repos_dir {d:?} must be a folder under the home directory, of letters, digits and . _ - /"
            ));
        }
        if !plain(&self.repo_forge, b"") {
            return Err(format!(
                "[tmux] repo_forge {:?} must be a host name",
                self.repo_forge
            ));
        }
        if self.repo_command.chars().count() > MAX_REPO_COMMAND_LEN
            || self.repo_command.chars().any(char::is_control)
        {
            return Err(format!(
                "[tmux] repo_command must be one line of at most {MAX_REPO_COMMAND_LEN} characters"
            ));
        }
        Ok(())
    }
}

/// Longest `[tmux] repo_command`.
pub const MAX_REPO_COMMAND_LEN: usize = 200;

/// The command that lists the login's tmux sessions (as [`list_command`])
/// and the git repos under `~/<repos_dir>` (those whose `origin` is on
/// `repo_forge`, when one is set), read by [`parse_repos`]. One SSH exec
/// for both. `cfg` must have passed [`TmuxConfig::check`].
///
/// Worktrees count (their `.git` is a file). `node_modules`, `vendor` and
/// `.claude` folders are not searched, nor deeper than 6 levels. Repos are
/// listed without tmux too, so a host without it still shows them.
pub fn repos_command(cfg: &TmuxConfig) -> String {
    sh(&format!("{}echo {DONE_MARK}", repos_script(cfg)))
}

/// [`repos_command`]'s script, without the end mark.
fn repos_script(cfg: &TmuxConfig) -> String {
    let dir = &cfg.repos_dir;
    let each = if cfg.repo_forge.is_empty() {
        format!("echo \"{REPO_MARK} $d\";")
    } else {
        format!(
            "case \"$(git -C \"$d\" config --get remote.origin.url 2>/dev/null)\" in \
                 *{}[:/]*) echo \"{REPO_MARK} $d\";; esac;",
            cfg.repo_forge
        )
    };
    // No parentheses or backslashes: find's -prune chain needs neither,
    // and fish would read a backslash inside the single quotes.
    format!(
        "echo \"{SERVER_MARK} $(id -un)\"; \
         if command -v tmux >/dev/null 2>&1; then {LIST_SESSIONS}; else echo {NOT_INSTALLED_MARK}; fi; \
         r=\"$HOME/{dir}\"; echo \"{ROOT_MARK} $r\"; \
         if [ -d \"$r\" ] && command -v git >/dev/null 2>&1; then \
           find \"$r\" -mindepth 2 -maxdepth 6 -name node_modules -prune -o -name vendor -prune -o -name .claude -prune -o -name .git -print 2>/dev/null \
           | while IFS= read -r g; do d=${{g%/.git}}; {each} done; \
         fi; "
    )
}

/// One repo under `~/GitLab`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Repo {
    /// Its folder on the host.
    pub path: String,
    /// The folder under `~/GitLab` (`acme/console`).
    pub rel: String,
    /// The tmux session name to start in it: the folder's name in
    /// [`valid_name`]'s characters, with its group in front when two repos
    /// share one.
    pub name: String,
    /// The tmux sessions started in this folder (or below it, where no
    /// repo nearer matches), most recently active first.
    pub sessions: Vec<String>,
}

/// What a host said about its repos and tmux sessions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RepoListing {
    /// The tmux listing; `installed` false when the host has no tmux.
    #[serde(flatten)]
    pub tmux: TmuxListing,
    /// The folder scanned (`~/GitLab`), when the host said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Sorted by `rel`.
    pub repos: Vec<Repo>,
    /// Sessions started in no repo's folder, most recently active first.
    pub other_sessions: Vec<String>,
}

/// `s` in [`valid_name`]'s characters, anything else as `-`, cut to
/// [`MAX_NAME_LEN`].
fn clean_name(s: &str) -> String {
    let mut n: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_-@+=,~".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    n.truncate(MAX_NAME_LEN);
    if n.is_empty() {
        n.push('-');
    }
    n
}

/// The repo `path` falls in: the one with the longest folder that is
/// `path` or holds it.
fn repo_of<'a>(repos: &'a [Repo], path: &str) -> Option<&'a Repo> {
    let path = path.trim_end_matches('/');
    repos
        .iter()
        .filter(|r| {
            path == r.path
                || path
                    .strip_prefix(r.path.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|r| r.path.len())
}

/// Read the output of [`repos_command`]. `None` when it is not that output.
pub fn parse_repos(stdout: &str) -> Option<RepoListing> {
    let mut tmux = parse_listing(stdout)?;
    // parse_listing stops early for a host without tmux; the repos follow.
    if !tmux.installed {
        tmux.login = stdout
            .lines()
            .find_map(|l| l.strip_prefix(SERVER_MARK)?.strip_prefix(' '))
            .map(|o| o.trim().to_string());
    }
    let mut root: Option<String> = None;
    let mut paths: Vec<String> = Vec::new();
    let mut done = false;
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim() == DONE_MARK {
            done = true;
            break;
        }
        if let Some(r) = line
            .strip_prefix(ROOT_MARK)
            .and_then(|r| r.strip_prefix(' '))
        {
            root = Some(r.trim_end_matches('/').to_string());
        } else if let Some(p) = line
            .strip_prefix(REPO_MARK)
            .and_then(|r| r.strip_prefix(' '))
        {
            if !p.is_empty() {
                paths.push(p.to_string());
            }
        }
    }
    if !done {
        return None;
    }
    paths.sort();
    paths.dedup();
    let rel = |p: &str| -> String {
        root.as_deref()
            .and_then(|r| p.strip_prefix(r))
            .map(|x| x.trim_start_matches('/').to_string())
            .unwrap_or_else(|| p.to_string())
    };
    let base = |p: &str| clean_name(p.rsplit('/').next().unwrap_or(p));
    let mut count = std::collections::HashMap::new();
    for p in &paths {
        *count.entry(base(p)).or_insert(0) += 1;
    }
    let mut repos: Vec<Repo> = paths
        .iter()
        .map(|p| {
            let r = rel(p);
            let mut name = base(p);
            if count[&name] > 1 {
                let group = r.split('/').next().unwrap_or("");
                name = clean_name(&format!("{group}-{name}"));
            }
            Repo {
                path: p.clone(),
                rel: r,
                name,
                sessions: Vec::new(),
            }
        })
        .collect();
    // Sessions are newest first, so each repo's list is too.
    let mut other_sessions = Vec::new();
    for s in &tmux.sessions {
        let hit = s
            .path
            .as_deref()
            .and_then(|p| repo_of(&repos, p))
            .map(|r| r.path.clone());
        match hit {
            Some(path) => {
                if let Some(r) = repos.iter_mut().find(|r| r.path == path) {
                    r.sessions.push(s.name.clone());
                }
            }
            None => other_sessions.push(s.name.clone()),
        }
    }
    repos.sort_by(|a, b| a.rel.cmp(&b.rel));
    Some(RepoListing {
        tmux,
        root,
        repos,
        other_sessions,
    })
}

// ── Dashboard ──

/// Prefix of the line per session's active pane: `@@rgpane name:command:title`.
const PANE_MARK: &str = "@@rgpane";
/// Around the screen of a pane running Claude: `@@rgscreen name` .. `@@rgscreen-end`.
const SCREEN_MARK: &str = "@@rgscreen";
const SCREEN_END: &str = "@@rgscreen-end";
/// Lines of screen kept per Claude pane.
pub const SCREEN_LINES: usize = 60;

/// [`repos_command`] plus each session's active-pane command and title, and
/// the last [`SCREEN_LINES`] lines of every active pane running Claude Code,
/// read by [`parse_dashboard`]. One SSH exec, as the entry's login.
pub fn dashboard_command(cfg: &TmuxConfig) -> String {
    sh(&format!(
        "{}if command -v tmux >/dev/null 2>&1; then \
           tmux list-panes -a -F \"#{{window_active}}#{{pane_active}}:#{{pane_current_command}}:#{{pane_id}}:#{{session_name}}:#{{pane_title}}\" 2>/dev/null \
           | while IFS=: read -r a c p n t; do [ \"$a\" = 11 ] || continue; \
               echo \"{PANE_MARK} $n:$c:$t\"; \
               case \"$c:$t\" in claude:*|*:✳*) echo \"{SCREEN_MARK} $n\"; \
                 tmux capture-pane -p -J -t \"$p\" -S -{SCREEN_LINES} 2>/dev/null | tail -n {SCREEN_LINES}; echo {SCREEN_END};; esac; done; \
         fi; echo {DONE_MARK}",
        repos_script(cfg)
    ))
}

/// What Claude Code in a pane is doing, as its screen shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClaudeState {
    /// `working` (busy: "esc to interrupt"), `asking` (a choice or
    /// permission prompt waits for the person) or `ready` (done; waiting for
    /// the next message).
    pub state: String,
    /// The end of what it said, above its input box: the question, or the
    /// last answer. Plain text, at most [`EXCERPT_LINES`] lines.
    pub excerpt: Vec<String>,
}

/// Lines kept in [`ClaudeState::excerpt`].
pub const EXCERPT_LINES: usize = 16;

/// Read Claude Code's state off a pane's screen. Heuristic until
/// something better than reading the screen replaces it.
pub fn claude_state(screen: &[String]) -> ClaudeState {
    let lines: Vec<&str> = screen.iter().map(|l| l.trim_end()).collect();
    let tail_has = |needle: &str| lines.iter().rev().take(12).any(|l| l.contains(needle));
    let asking = lines.iter().rev().take(25).any(|l| {
        let t = l.trim_start_matches(['│', '|', ' ']);
        t.starts_with("❯ 1.")
            || t.starts_with("Do you want")
            || t.contains("Would you like to proceed")
    });
    let state = if tail_has("esc to interrupt") {
        "working"
    } else if asking {
        "asking"
    } else {
        "ready"
    };
    // The excerpt: for a prompt, the prompt itself (the end of the screen);
    // otherwise what is above the input box (its top border is a line of ─).
    let is_rule = |l: &str| {
        let t = l.trim();
        t.chars().count() >= 10 && t.chars().all(|c| "─━╭╮╰╯│ ".contains(c))
    };
    let end = if state == "asking" {
        lines.len()
    } else {
        // The box's top border: the second-to-last rule (the last closes it),
        // or the last if there is only one.
        let rules: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| is_rule(l))
            .map(|(i, _)| i)
            .collect();
        match rules.len() {
            0 => lines.len(),
            1 => rules[0],
            n => rules[n - 2],
        }
    };
    let mut excerpt: Vec<String> = lines[..end]
        .iter()
        .filter(|l| !l.trim().is_empty() && !is_rule(l))
        .map(|l| l.to_string())
        .collect();
    if excerpt.len() > EXCERPT_LINES {
        excerpt.drain(..excerpt.len() - EXCERPT_LINES);
    }
    ClaudeState {
        state: state.into(),
        excerpt,
    }
}

/// Read the output of [`dashboard_command`]: [`parse_repos`] with each
/// session's command, title and Claude state filled in.
pub fn parse_dashboard(stdout: &str) -> Option<RepoListing> {
    // Screens can hold anything, so they are cut out before the rest is read.
    let mut rest = String::new();
    let mut screens: Vec<(String, Vec<String>)> = Vec::new();
    let mut panes: Vec<(String, String, String)> = Vec::new();
    let mut in_screen: Option<(String, Vec<String>)> = None;
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if let Some((_, buf)) = in_screen.as_mut() {
            if line == SCREEN_END {
                screens.push(in_screen.take().expect("in a screen"));
            } else {
                buf.push(line.to_string());
            }
            continue;
        }
        if let Some(n) = line
            .strip_prefix(SCREEN_MARK)
            .and_then(|r| r.strip_prefix(' '))
        {
            in_screen = Some((n.to_string(), Vec::new()));
            continue;
        }
        if let Some(p) = line
            .strip_prefix(PANE_MARK)
            .and_then(|r| r.strip_prefix(' '))
        {
            let mut f = p.splitn(3, ':');
            if let (Some(n), Some(c), t) = (f.next(), f.next(), f.next()) {
                panes.push((n.to_string(), c.to_string(), t.unwrap_or("").to_string()));
            }
            continue;
        }
        rest.push_str(line);
        rest.push('\n');
    }
    let mut l = parse_repos(&rest)?;
    for s in l.tmux.sessions.iter_mut() {
        if let Some((_, c, t)) = panes.iter().find(|(n, _, _)| *n == s.name) {
            s.command = Some(c.clone()).filter(|c| !c.is_empty());
            s.title = Some(t.clone()).filter(|t| !t.is_empty());
        }
        if let Some((_, screen)) = screens.iter().find(|(n, _)| *n == s.name) {
            s.claude = Some(claude_state(screen));
        }
    }
    Some(l)
}

/// Longest answer accepted.
pub const MAX_SEND_LEN: usize = 8192;
const SENT_MARK: &str = "@@rg-sent";
const NO_SESSION_MARK: &str = "@@rg-no-session";

/// The command that types `text` into the running session `name` (its
/// active pane), then Enter when `enter`. Never creates a session. `None`
/// for an invalid name or text. The text goes over as base64.
pub fn send_command(name: &str, text: &str, enter: bool) -> Option<String> {
    use base64::Engine;
    if !valid_name(name) || text.len() > MAX_SEND_LEN || text.contains('\0') {
        return None;
    }
    let b = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let enter = if enter {
        format!("tmux send-keys -t \"={name}:\" Enter && ")
    } else {
        String::new()
    };
    Some(sh(&format!(
        "command -v tmux >/dev/null 2>&1 || {{ echo {NOT_INSTALLED_MARK}; exit 0; }}; \
         tmux has-session -t \"={name}\" 2>/dev/null || {{ echo {NO_SESSION_MARK}; exit 0; }}; \
         c=$(printf %s \"{b}\" | base64 -d); \
         {{ [ -z \"$c\" ] || tmux send-keys -t \"={name}:\" -l -- \"$c\"; }} && {enter}echo {SENT_MARK}"
    )))
}

/// What a send did: `sent`, `no_session`, `not_installed`, or `None` when
/// the output is not understood.
pub fn parse_send(stdout: &str) -> Option<&'static str> {
    for l in stdout.lines().map(str::trim) {
        match l {
            SENT_MARK => return Some("sent"),
            NO_SESSION_MARK => return Some("no_session"),
            NOT_INSTALLED_MARK => return Some("not_installed"),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_shell_inert() {
        for ok in ["deploy", "rg-alice", "a_b", "x@y", "v=1,2", "~home", "A9"] {
            assert!(valid_name(ok), "{ok}");
        }
        let long = "a".repeat(MAX_NAME_LEN + 1);
        for bad in [
            "",
            "a b",
            "a;b",
            "$(id)",
            "`id`",
            "a'b",
            "a\"b",
            "a\\b",
            "a.b",
            "a:b",
            "a\nb",
            "a|b",
            "a&b",
            "ü",
            long.as_str(),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn attach_creates_or_attaches_and_explains_a_missing_tmux() {
        let cmd = attach_command("deploy").unwrap();
        assert!(cmd.starts_with("sh -c '") && cmd.ends_with('\''));
        // One single-quoted word for the login shell.
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(cmd.contains(
            "exec tmux -u new-session -A -s \"deploy\" \\; set-option -s set-clipboard on;"
        ));
        assert!(cmd.contains("tmux is not installed on this host"));
        assert!(cmd.contains("read _"));
        assert_eq!(attach_command("a;reboot"), None);
        assert_eq!(attach_command("it's"), None);
    }

    fn spec(name: &str, dir: &str, commands: &str) -> StartSpec {
        StartSpec {
            name: name.into(),
            dir: dir.into(),
            commands: commands.into(),
        }
    }

    #[test]
    fn start_sends_the_users_text_only_as_base64() {
        let specs = [
            spec(
                "billing",
                "/srv/it's here",
                "cd /x; echo \"$HOME\" 'q' `id` \\",
            ),
            spec("auth", "", ""),
        ];
        let cmd = start_command(&specs).unwrap();
        // One single-quoted word for the login shell, and no backslash for
        // fish to read inside it.
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(!cmd.contains('\\'));
        assert!(!cmd.contains("it's") && !cmd.contains("`id`"));
        assert!(cmd.contains("rg_new \"billing\" \"L3Nydi9pdCdzIGhlcmU=\" && m0=1;"));
        assert!(cmd.contains("rg_new \"auth\" \"\" && m1=1;"));
        // Commands only for a session this start created, and none for one
        // with no commands.
        assert!(cmd.contains("[ -n \"$m0\" ] && rg_keys \"billing\" "));
        assert!(!cmd.contains("rg_keys \"auth\""));
        assert!(cmd.ends_with("echo @@rustguac-done'"));
    }

    #[test]
    fn start_refuses_what_it_cannot_send() {
        assert!(check_specs(&[]).is_err());
        assert!(check_specs(&[spec("a;b", "", "")]).is_err());
        assert!(check_specs(&[spec("a", "", ""), spec("a", "", "")]).is_err());
        assert!(check_specs(&[spec("a", "/x\ny", "")]).is_err());
        assert!(check_specs(&[spec("a", "", &"x".repeat(MAX_COMMANDS_LEN + 1))]).is_err());
        let many: Vec<_> = (0..=MAX_START)
            .map(|i| spec(&format!("s{i}"), "", ""))
            .collect();
        assert!(check_specs(&many).is_err());
        assert_eq!(start_command(&many), None);
        assert!(check_specs(&[spec("a", "~/x", "claude --continue")]).is_ok());
    }

    #[test]
    fn start_outcome_is_read_per_session() {
        let specs = [
            spec("a", "", "x"),
            spec("b", "", "y"),
            spec("c", "/nope", "z"),
            spec("d", "", ""),
        ];
        let out =
            "motd\n@@rg created a\n@@rg running b\n@@rg no_dir c\n@@rg sent a\n@@rustguac-done\n";
        let o = parse_start(out, &specs).unwrap();
        assert!(o.installed && !o.no_base64);
        let got: Vec<_> = o
            .sessions
            .iter()
            .map(|s| (s.name.as_str(), s.state.as_str(), s.commands_sent))
            .collect();
        assert_eq!(
            got,
            [
                ("a", "created", true),
                ("b", "running", false),
                ("c", "no_dir", false),
                ("d", "failed", false)
            ]
        );
        assert_eq!(parse_start("@@rg created a\n", &specs), None);
        assert!(
            !parse_start("@@rustguac-no-tmux\n", &specs)
                .unwrap()
                .installed
        );
        assert!(
            parse_start("@@rustguac-no-base64\n", &specs)
                .unwrap()
                .no_base64
        );
    }

    #[test]
    fn list_command_is_one_quoted_word() {
        let cmd = list_command();
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(cmd.contains("tmux list-sessions -F"));
    }

    #[test]
    fn listing_asks_only_the_logins_own_server() {
        // No other user's socket, so root sees only root's sessions.
        let cmd = list_command();
        assert!(!cmd.contains("-S ") && !cmd.contains("/tmp/tmux-") && !cmd.contains("-L "));
        assert_eq!(cmd.matches("tmux list-sessions").count(), 1);
        assert!(cmd.contains("#{session_path}"));
    }

    #[test]
    fn listing_runs_on_a_real_tmux() {
        // The command itself, through sh, against a private tmux server.
        if std::process::Command::new("tmux")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!("rg-tmux-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.to_str().unwrap();
        let run = |args: &[&str]| {
            std::process::Command::new("tmux")
                .env("TMUX_TMPDIR", tmp)
                .env_remove("TMUX")
                .args(args)
                .status()
                .unwrap()
        };
        assert!(run(&["new-session", "-d", "-s", "rg-test", "-c", "/tmp"]).success());
        let cmd = list_command();
        let script = &cmd["sh -c '".len()..cmd.len() - 1];
        let out = std::process::Command::new("sh")
            .env("TMUX_TMPDIR", tmp)
            .env_remove("TMUX")
            .args(["-c", script])
            .output()
            .unwrap();
        run(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
        let l = parse_listing(&String::from_utf8_lossy(&out.stdout)).unwrap();
        assert!(l.login.is_some());
        assert_eq!(l.sessions.len(), 1);
        assert_eq!(l.sessions[0].name, "rg-test");
        assert_eq!(l.sessions[0].path.as_deref(), Some("/tmp"));
    }

    #[test]
    fn listing_reads_sessions_newest_first() {
        let out = "Welcome to web-01\n\
                   Last login: Mon Oct 26 05:43:14 2026\n\
                   @@rgsrv root\n\
                   build:0:1:1700000000:1700000100:/root/GitLab/acme/a\n\
                   deploy:1:3:1700000000:1700000500:/srv/x:y\n\
                   my session:0:1:1700000000:1700000050:\n\
                   @@rustguac-done\n";
        let l = parse_listing(out).unwrap();
        assert!(l.installed);
        assert_eq!(l.login.as_deref(), Some("root"));
        // The folder comes last and keeps any `:` in it.
        assert_eq!(l.sessions[0].path.as_deref(), Some("/srv/x:y"));
        assert_eq!(l.sessions[1].path.as_deref(), Some("/root/GitLab/acme/a"));
        assert_eq!(l.sessions[2].path, None);
        let names: Vec<_> = l.sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["deploy", "build", "my session"]);
        assert_eq!(l.sessions[0].attached, 1);
        assert_eq!(l.sessions[0].windows, 3);
        assert_eq!(l.sessions[0].activity, Some(1700000500));
        assert!(l.sessions[0].attachable);
        assert!(!l.sessions[2].attachable);
    }

    #[test]
    fn listing_without_a_server_is_empty() {
        let l = parse_listing("@@rustguac-done\n").unwrap();
        assert!(l.installed);
        assert!(l.sessions.is_empty());
    }

    #[test]
    fn listing_says_when_tmux_is_missing() {
        let l = parse_listing("@@rustguac-no-tmux\n").unwrap();
        assert!(!l.installed);
        assert!(reports_not_installed("motd\n@@rustguac-no-tmux\n"));
    }

    #[test]
    fn a_listing_cut_short_is_not_empty() {
        assert_eq!(parse_listing("deploy:1:3:1:2:/x\n"), None);
        assert_eq!(parse_listing(""), None);
    }

    #[test]
    fn repos_command_is_one_quoted_word_without_backslashes() {
        let cmd = repos_command(&forge());
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(!cmd.contains('\\'));
        assert!(cmd.contains("remote.origin.url") && cmd.contains("git.example.com[:/]"));
        assert!(cmd.contains("$HOME/GitLab"));
        assert!(!cmd.contains("/tmp/tmux-") && !cmd.contains("-S "));
        // Without a forge, every repo is listed and its origin is not read.
        let any = repos_command(&TmuxConfig {
            repos_dir: "src/work".into(),
            ..Default::default()
        });
        assert_eq!(any.matches('\'').count(), 2);
        assert!(!any.contains('\\') && !any.contains("remote.origin.url"));
        assert!(any.contains("$HOME/src/work"));
    }

    /// A config listing only one forge's clones.
    fn forge() -> TmuxConfig {
        TmuxConfig {
            repo_forge: "git.example.com".into(),
            ..Default::default()
        }
    }

    #[test]
    fn config_refuses_what_a_shell_would_read() {
        assert!(TmuxConfig::default().check().is_ok());
        assert!(forge().check().is_ok());
        let dir = |d: &str| TmuxConfig {
            repos_dir: d.into(),
            ..Default::default()
        };
        for ok in ["src", "src/work", "Code.d/my_repos-2"] {
            assert!(dir(ok).check().is_ok(), "{ok}");
        }
        for bad in [
            "", "/etc", "../x", "a/../b", "a//b", "a b", "$HOME", "a'b", "a;b", "-x", "a/",
        ] {
            assert!(dir(bad).check().is_err(), "{bad}");
        }
        for bad in ["git.example.com/x", "a b", "x'y", "$(id)", "a*"] {
            let c = TmuxConfig {
                repo_forge: bad.into(),
                ..Default::default()
            };
            assert!(c.check().is_err(), "{bad}");
        }
        let cmd = |c: &str| TmuxConfig {
            repo_command: c.into(),
            ..Default::default()
        };
        assert!(cmd("claude -n {repo}").check().is_ok());
        assert!(cmd("a\nb").check().is_err());
        assert!(cmd(&"x".repeat(201)).check().is_err());
    }

    #[test]
    fn repos_are_matched_to_sessions_by_folder() {
        let out = "motd\n\
            @@rgsrv root\n\
            rg:1:1:1:300:/root/GitLab/acme/console\n\
            sites:0:1:1:200:/root/GitLab/acme/sites/billing.example.com/src\n\
            home:0:1:1:100:/root\n\
            old:0:1:1:50:/root/GitLab/acme/console/\n\
            @@rgroot /root/GitLab\n\
            @@rgrepo /root/GitLab/acme/sites\n\
            @@rgrepo /root/GitLab/acme/sites/billing.example.com\n\
            @@rgrepo /root/GitLab/acme/console\n\
            @@rgrepo /root/GitLab/acme/rustguac\n\
            @@rgrepo /root/GitLab/acme/claude\n\
            @@rgrepo /root/GitLab/other/claude\n\
            @@rustguac-done\n";
        let l = parse_repos(out).unwrap();
        assert_eq!(l.tmux.login.as_deref(), Some("root"));
        assert_eq!(l.root.as_deref(), Some("/root/GitLab"));
        let got: Vec<_> = l
            .repos
            .iter()
            .map(|r| (r.rel.as_str(), r.name.as_str(), r.sessions.join(",")))
            .collect();
        assert_eq!(
            got,
            [
                ("acme/claude", "acme-claude", "".into()),
                // Newest first; a trailing / still matches.
                ("acme/console", "console", "rg,old".into()),
                ("acme/rustguac", "rustguac", "".into()),
                ("acme/sites", "sites", "".into()),
                // The nearest repo wins over the one holding it.
                (
                    "acme/sites/billing.example.com",
                    "billing-example-com",
                    "sites".into()
                ),
                ("other/claude", "other-claude", "".into()),
            ]
        );
        // rustguac is not matched by rustguac-tmux's folder.
        assert_eq!(l.other_sessions, ["home"]);
    }

    #[test]
    fn repos_are_listed_without_tmux_and_need_the_end_mark() {
        let out = "@@rgsrv alice-example.com\n@@rustguac-no-tmux\n@@rgroot /home/alice-example.com/GitLab\n\
                   @@rgrepo /home/alice-example.com/GitLab/acme/x\n@@rustguac-done\n";
        let l = parse_repos(out).unwrap();
        assert!(!l.tmux.installed);
        assert_eq!(l.tmux.login.as_deref(), Some("alice-example.com"));
        assert_eq!(l.repos.len(), 1);
        assert_eq!(l.repos[0].rel, "acme/x");
        assert_eq!(parse_repos("@@rgsrv root\n@@rgrepo /x\n"), None);
    }

    #[test]
    fn repo_session_names_are_valid() {
        for s in ["billing.example.com", "a b", "ü", &"x".repeat(100)] {
            assert!(valid_name(&clean_name(s)), "{s}");
        }
    }

    #[test]
    fn repos_command_runs_on_a_real_host() {
        // Through sh, against a temporary ~ with one clone from the forge and
        // one from elsewhere.
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let home = std::env::temp_dir().join(format!("rg-repos-test-{}", std::process::id()));
        let mk = |rel: &str, url: &str| {
            let d = home.join("GitLab").join(rel);
            std::fs::create_dir_all(&d).unwrap();
            let git = |args: &[&str]| {
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(&d)
                    .args(args)
                    .output()
                    .unwrap()
            };
            git(&["init", "-q"]);
            git(&["remote", "add", "origin", url]);
        };
        mk("acme/mine", "git@git.example.com:acme/mine.git");
        mk("gh/other", "https://github.com/x/other.git");
        mk(
            "acme/mine/node_modules/dep",
            "git@git.example.com:acme/dep.git",
        );
        let rels = |cfg: &TmuxConfig| -> Vec<String> {
            let cmd = repos_command(cfg);
            let script = &cmd["sh -c '".len()..cmd.len() - 1];
            let out = std::process::Command::new("sh")
                .env("HOME", &home)
                .env("TMUX_TMPDIR", &home)
                .env_remove("TMUX")
                .args(["-c", script])
                .output()
                .unwrap();
            let l = parse_repos(&String::from_utf8_lossy(&out.stdout)).unwrap();
            l.repos.iter().map(|r| r.rel.clone()).collect()
        };
        let (one, all) = (rels(&forge()), rels(&TmuxConfig::default()));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(one, ["acme/mine"]);
        assert_eq!(all, ["acme/mine", "gh/other"]);
    }

    fn screen(s: &str) -> Vec<String> {
        s.lines().map(str::to_string).collect()
    }

    #[test]
    fn claude_state_reads_working_asking_and_ready() {
        let working = screen("● Doing the thing\n· Prestidigitating… (14m 25s)\n──────────────\n❯ \n──────────────\n  ⏵⏵ bypass permissions on · esc to interrupt\n");
        assert_eq!(claude_state(&working).state, "working");
        let ready = screen("● Merged !4 and !5.\n  Next: the dashboard.\n──────────────\n❯ \n──────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n");
        let r = claude_state(&ready);
        assert_eq!(r.state, "ready");
        assert_eq!(r.excerpt, ["● Merged !4 and !5.", "  Next: the dashboard."]);
        let asking = screen("● Bash(rm -rf build)\n╭──────────────────────╮\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. No, and tell Claude\n╰──────────────────────╯\n");
        let a = claude_state(&asking);
        assert_eq!(a.state, "asking");
        assert!(a
            .excerpt
            .iter()
            .any(|l| l.contains("Do you want to proceed?")));
        let long: Vec<String> = (0..40).map(|i| format!("line {i}")).collect();
        assert_eq!(claude_state(&long).excerpt.len(), EXCERPT_LINES);
    }

    #[test]
    fn dashboard_output_fills_sessions_and_keeps_screens_out_of_the_listing() {
        let out = "@@rgsrv root\n\
            rg:1:1:1:300:/root/GitLab/acme/console\n\
            shell:0:1:1:100:/root\n\
            @@rgroot /root/GitLab\n\
            @@rgrepo /root/GitLab/acme/console\n\
            @@rgpane rg:claude:✳ Plan: the dashboard\n\
            @@rgpane shell:zsh:\n\
            @@rgscreen rg\n\
            fake:1:1:1:1:/looks/like/a/session\n\
            @@rgrepo /not/a/repo\n\
            ● All done: 3 MRs merged.\n\
            ──────────────\n❯ \n──────────────\n\
            @@rgscreen-end\n\
            @@rustguac-done\n";
        let l = parse_dashboard(out).unwrap();
        assert_eq!(l.tmux.sessions.len(), 2);
        assert_eq!(l.repos.len(), 1);
        let rg = &l.tmux.sessions[0];
        assert_eq!(rg.command.as_deref(), Some("claude"));
        assert_eq!(rg.title.as_deref(), Some("✳ Plan: the dashboard"));
        let c = rg.claude.as_ref().unwrap();
        assert_eq!(c.state, "ready");
        assert_eq!(
            c.excerpt.last().map(String::as_str),
            Some("● All done: 3 MRs merged.")
        );
        let sh = &l.tmux.sessions[1];
        assert_eq!(sh.command.as_deref(), Some("zsh"));
        assert!(sh.title.is_none() && sh.claude.is_none());
    }

    #[test]
    fn dashboard_command_is_one_quoted_word_without_backslashes() {
        let cmd = dashboard_command(&forge());
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(!cmd.contains('\\'));
        assert!(cmd.contains("capture-pane -p -J"));
        assert!(!cmd.contains("/tmp/tmux-") && !cmd.contains("-S /"));
    }

    #[test]
    fn send_only_types_into_a_running_session() {
        let cmd = send_command("rg", "yes, go ahead; rm 'x' `id`", true).unwrap();
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(!cmd.contains("`id`") && !cmd.contains("go ahead"));
        assert!(cmd.contains("has-session -t \"=rg\""));
        assert!(!cmd.contains("new-session"));
        assert!(cmd.contains("send-keys -t \"=rg:\" Enter"));
        assert!(!send_command("rg", "x", false).unwrap().contains("Enter"));
        assert!(send_command("a;b", "x", true).is_none());
        assert!(send_command("rg", &"x".repeat(MAX_SEND_LEN + 1), true).is_none());
        assert_eq!(parse_send("motd\n@@rg-sent\n"), Some("sent"));
        assert_eq!(parse_send("@@rg-no-session\n"), Some("no_session"));
        assert_eq!(parse_send(""), None);
    }

    #[test]
    fn dashboard_and_send_run_on_a_real_tmux() {
        if std::process::Command::new("tmux")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!("rg-dash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.to_str().unwrap();
        let tmux = |args: &[&str]| {
            std::process::Command::new("tmux")
                .env("TMUX_TMPDIR", tmp)
                .env_remove("TMUX")
                .args(args)
                .output()
                .unwrap()
        };
        let run = |cmd: &str| {
            let script = &cmd["sh -c '".len()..cmd.len() - 1];
            let o = std::process::Command::new("sh")
                .env("TMUX_TMPDIR", tmp)
                .env("HOME", tmp)
                .env_remove("TMUX")
                .args(["-c", script])
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).to_string()
        };
        assert!(tmux(&[
            "new-session",
            "-d",
            "-s",
            "dash",
            "-x",
            "80",
            "-y",
            "20",
            "cat"
        ])
        .status
        .success());
        let sent = run(&send_command("dash", "hello dashboard", true).unwrap());
        let missing = run(&send_command("nope", "x", true).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(300));
        let l = parse_dashboard(&run(&dashboard_command(&TmuxConfig::default())));
        let screen = String::from_utf8_lossy(&tmux(&["capture-pane", "-p", "-t", "dash"]).stdout)
            .to_string();
        tmux(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(parse_send(&sent), Some("sent"));
        assert_eq!(parse_send(&missing), Some("no_session"));
        assert!(screen.contains("hello dashboard"));
        let l = l.unwrap();
        assert_eq!(l.tmux.sessions[0].command.as_deref(), Some("cat"));
        assert!(l.tmux.sessions[0].claude.is_none());
    }
}
