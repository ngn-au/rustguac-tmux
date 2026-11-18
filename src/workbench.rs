//! Work bench folders.
//!
//! Every member of one Unix group on the work bench host (a shared Linux
//! server people work on; the host may read the group from a directory over
//! NSS) gets:
//!
//! - a shared folder `<prefix><email>` (`wb-alice-example-com`) titled
//!   "Work Bench - <email>", visible only to that person (`allowed_users`);
//! - in it, one SSH entry to the host as their own Unix user, tmux on, with a
//!   key rustguac generated and keeps in Vault;
//! - that key's public half in their `~/.ssh/authorized_keys` on the host,
//!   restricted to the console's address (`from="..."`) and marked with
//!   `key_marker`, so it works only from the console.
//!
//! Someone who leaves the group loses the folder and the key at the next
//! sync. The sync is idempotent: run it as often as you like
//! (`rustguac workbench-sync`, or `[workbench] interval_mins` in the server).
//!
//! The host is reached with the credentials of an existing entry
//! (`admin_entry`, a root login), so no secret of its own is configured.
//! Membership is read on the host (`getent group`), so nothing here talks to
//! an identity provider.
//!
//! Decisions are made by pure functions ([`member_plan`], [`host_actions`],
//! [`departed_folders`]) so they are unit-tested without Vault or a host.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::vault::{AddressBookEntry, FolderConfig};

/// `[workbench]` in config.toml.
#[derive(Debug, Deserialize, Clone)]
pub struct WorkbenchConfig {
    /// Address the entries connect to (and the sync logs in to).
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// The host's name, for the entry's name and title. Default: `host`.
    #[serde(default)]
    pub host_label: String,
    /// Unix group whose members get a work bench, as the host resolves it.
    pub group: String,
    /// `scope/folder/entry` of the entry whose credentials (a root login)
    /// the sync uses to read the group and write the keys.
    pub admin_entry: String,
    /// The console's address as the host sees it: `from="..."` on the keys.
    pub console_from: String,
    /// Unix user = email local part + this (`alice` + `-example.com`).
    /// Default: empty, the Unix user is the local part.
    #[serde(default)]
    pub user_suffix: String,
    /// Email = local part + `@` + this. Required.
    #[serde(default)]
    pub email_domain: String,
    /// The comment that marks a console key in `authorized_keys`. Lines
    /// carrying it are the sync's to replace or remove; nothing else is
    /// touched. Changing it orphans the keys already installed.
    #[serde(default = "default_key_marker")]
    pub key_marker: String,
    /// Folder key = this + the email with `@` and `.` as `-`.
    #[serde(default = "default_folder_prefix")]
    pub folder_prefix: String,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    /// Run the sync in the server every this many minutes. 0: only on
    /// demand (`rustguac workbench-sync`).
    #[serde(default)]
    pub interval_mins: u64,
    /// Remove the folder and key of someone no longer in the group.
    #[serde(default = "default_true")]
    pub remove_departed: bool,
}

fn default_port() -> u16 {
    22
}
fn default_key_marker() -> String {
    "rustguac-console".into()
}
fn default_folder_prefix() -> String {
    "wb-".into()
}
fn default_display_name() -> String {
    "Work Bench".into()
}
fn default_scope() -> String {
    "shared".into()
}
fn default_true() -> bool {
    true
}

impl WorkbenchConfig {
    pub fn host_label(&self) -> &str {
        if self.host_label.is_empty() {
            &self.host
        } else {
            &self.host_label
        }
    }

    /// Why this config cannot be used, if it cannot.
    pub fn check(&self) -> Result<(), String> {
        if !valid_unix_name(&self.group) {
            return Err(format!(
                "[workbench] group {:?} is not a usable group name",
                self.group
            ));
        }
        if self.admin_entry_parts().is_none() {
            return Err("[workbench] admin_entry must be scope/folder/entry".into());
        }
        if self.console_from.is_empty()
            || !self
                .console_from
                .chars()
                .all(|c| c.is_ascii_hexdigit() || ".:/,".contains(c))
        {
            return Err("[workbench] console_from must be addresses (e.g. 198.51.100.7)".into());
        }
        if self.host.is_empty() {
            return Err("[workbench] host is required".into());
        }
        if !valid_domain(&self.email_domain) {
            return Err("[workbench] email_domain is required (e.g. example.com)".into());
        }
        if !self.user_suffix.is_empty() && !valid_unix_name(&format!("u{}", self.user_suffix)) {
            return Err("[workbench] user_suffix has characters a Unix user name cannot".into());
        }
        // The marker is matched in authorized_keys and written into a shell
        // script: one plain word.
        if !valid_marker(&self.key_marker) {
            return Err(
                "[workbench] key_marker must be one word of letters, digits and . _ -".into(),
            );
        }
        Ok(())
    }

    /// `admin_entry` as (scope, folder, entry).
    pub fn admin_entry_parts(&self) -> Option<(&str, &str, &str)> {
        let (scope, rest) = self.admin_entry.split_once('/')?;
        let (folder, entry) = rest.rsplit_once('/')?;
        (!scope.is_empty() && !folder.is_empty() && !entry.is_empty())
            .then_some((scope, folder, entry))
    }

    /// The person's email for a Unix user, if the user is one of ours.
    pub fn email_of(&self, user: &str) -> Option<String> {
        let local = user.strip_suffix(&self.user_suffix)?;
        (!local.is_empty()).then(|| format!("{local}@{}", self.email_domain))
    }

    /// The Unix user for an email, if the email is one of ours.
    pub fn user_of(&self, email: &str) -> Option<String> {
        let local = email
            .to_ascii_lowercase()
            .strip_suffix(&format!("@{}", self.email_domain.to_ascii_lowercase()))?
            .to_string();
        (!local.is_empty()).then(|| format!("{local}{}", self.user_suffix))
    }

    pub fn folder_of(&self, email: &str) -> String {
        let key: String = email
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c == '@' || c == '.' { '-' } else { c })
            .collect();
        format!("{}{key}", self.folder_prefix)
    }

    /// The entry's key in the folder: the host's name.
    pub fn entry_name(&self) -> String {
        self.host_label().to_string()
    }

    pub fn folder_config(&self, email: &str, user: &str) -> FolderConfig {
        FolderConfig {
            allowed_groups: Vec::new(),
            allowed_users: vec![email.to_string()],
            description: format!(
                "{} ({}) for {email}, as {user} ({}). Managed by rustguac workbench-sync.",
                self.display_name,
                self.host_label(),
                self.group
            ),
            // With the email, so admins, who see every one of them, can
            // tell them apart.
            display_name: format!("{} - {email}", self.display_name),
            inherit_from_parent: false,
        }
    }
}

/// A key marker: one word of letters, digits and `. _ -`.
fn valid_marker(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 64
        && m.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// A DNS name: labels of letters, digits and `-`, joined by dots.
fn valid_domain(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 253
        && d.split('.').all(|l| {
            !l.is_empty()
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// A Unix user or group name the host can be asked about: 1 to 64 of
/// `a-z A-Z 0-9 _ - .`, not starting with `-` or `.`.
pub fn valid_unix_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && !n.starts_with(['-', '.'])
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
}

// ── The host ──

const DONE: &str = "@@wb-done";

fn sh(script: &str) -> String {
    debug_assert!(!script.contains('\''));
    format!("sh -c '{script}'")
}

/// The command that reads the group's members and every console key on the
/// host, read by [`parse_survey`].
pub fn survey_command(group: &str, marker: &str) -> Option<String> {
    if !valid_unix_name(group) || !valid_marker(marker) {
        return None;
    }
    Some(sh(&format!(
        "echo \"@@wb-group $(getent group \"{group}\" | cut -d: -f4)\"; \
         for f in /home/*/.ssh/authorized_keys; do [ -f \"$f\" ] || continue; \
           u=$(stat -c %U \"$f\"); grep -F \" {marker}\" \"$f\" | while IFS= read -r l; do echo \"@@wb-key $u $l\"; done; done; \
         echo {DONE}"
    )))
}

/// What the host said: the group's members, and each user's console keys
/// (as `type base64`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Survey {
    pub members: BTreeSet<String>,
    pub keys: BTreeMap<String, Vec<String>>,
}

/// `type base64` of an authorized_keys line or public key, if it has one.
pub fn key_blob(line: &str) -> Option<String> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    let i = toks
        .iter()
        .position(|t| t.starts_with("ssh-") || t.starts_with("ecdsa-") || t.starts_with("sk-"))?;
    let b64 = toks.get(i + 1)?;
    Some(format!("{} {}", toks[i], b64))
}

pub fn parse_survey(stdout: &str) -> Option<Survey> {
    let mut s = Survey::default();
    let mut done = false;
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim() == DONE {
            done = true;
            break;
        }
        if let Some(m) = line.strip_prefix("@@wb-group") {
            s.members = m
                .trim()
                .split(',')
                .map(str::trim)
                .filter(|u| valid_unix_name(u))
                .map(str::to_string)
                .collect();
        } else if let Some(rest) = line.strip_prefix("@@wb-key ") {
            let Some((user, l)) = rest.split_once(' ') else {
                continue;
            };
            if let Some(b) = key_blob(l) {
                s.keys.entry(user.to_string()).or_default().push(b);
            }
        }
    }
    done.then_some(s)
}

/// A change to one user's console key on the host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HostAction {
    /// Replace the user's console keys with this one line.
    Install { user: String, line: String },
    /// Remove the user's console keys.
    Remove { user: String },
}

/// The command that applies `actions`, read by [`parse_apply`]. Each line
/// goes over as base64. An install refuses a user who is not in `group` at
/// that moment, creates their home if it does not exist yet (they have
/// never logged in), and replaces only lines carrying the key marker.
pub fn apply_command(group: &str, marker: &str, actions: &[HostAction]) -> Option<String> {
    use base64::Engine;
    if !valid_unix_name(group) || !valid_marker(marker) {
        return None;
    }
    let mut script = format!(
        "m=\",$(getent group \"{group}\" | cut -d: -f4),\"; \
         wb_set() {{ u=\"$1\"; \
           h=$(getent passwd \"$u\" | cut -d: -f6); \
           if [ -z \"$h\" ]; then echo \"@@wb-fail $u no_user\"; return; fi; \
           if [ \"$2\" != \"-\" ]; then case \"$m\" in *\",$u,\"*) ;; *) echo \"@@wb-fail $u not_member\"; return;; esac; fi; \
           if [ ! -d \"$h\" ]; then if [ \"$2\" = \"-\" ]; then echo \"@@wb-ok $u\"; return; fi; \
             mkhomedir_helper \"$u\" 0077 2>/dev/null || {{ echo \"@@wb-fail $u no_home\"; return; }}; fi; \
           g=$(id -g \"$u\"); install -d -m 700 -o \"$u\" -g \"$g\" \"$h/.ssh\" || {{ echo \"@@wb-fail $u ssh_dir\"; return; }}; \
           f=\"$h/.ssh/authorized_keys\"; t=\"$h/.ssh/.authorized_keys.rg$$\"; \
           {{ if [ -f \"$f\" ]; then grep -vF \" {marker}\" \"$f\"; fi; \
              if [ \"$2\" != \"-\" ]; then printf %s \"$2\" | base64 -d; echo; fi; }} > \"$t\"; \
           chown \"$u:$g\" \"$t\" && chmod 600 \"$t\" && mv \"$t\" \"$f\" && echo \"@@wb-ok $u\" || {{ rm -f \"$t\"; echo \"@@wb-fail $u write\"; }}; }}; "
    );
    for a in actions {
        let (user, arg) = match a {
            HostAction::Install { user, line } => (
                user,
                base64::engine::general_purpose::STANDARD.encode(line.as_bytes()),
            ),
            HostAction::Remove { user } => (user, "-".to_string()),
        };
        if !valid_unix_name(user) {
            return None;
        }
        script.push_str(&format!("wb_set \"{user}\" \"{arg}\"; "));
    }
    script.push_str(&format!("echo {DONE}"));
    Some(sh(&script))
}

/// Per user: `Ok` or the reason it failed. `None` when the output is cut
/// short.
pub fn parse_apply(stdout: &str) -> Option<BTreeMap<String, Result<(), String>>> {
    let mut out = BTreeMap::new();
    let mut done = false;
    for line in stdout.lines() {
        let line = line.trim();
        if line == DONE {
            done = true;
            break;
        }
        if let Some(u) = line.strip_prefix("@@wb-ok ") {
            out.insert(u.to_string(), Ok(()));
        } else if let Some(rest) = line.strip_prefix("@@wb-fail ") {
            if let Some((u, why)) = rest.split_once(' ') {
                out.insert(u.to_string(), Err(why.to_string()));
            }
        }
    }
    done.then_some(out)
}

// ── Decisions ──

/// The authorized_keys line for a public key (`type base64`).
pub fn key_line(cfg: &WorkbenchConfig, blob: &str, email: &str) -> String {
    format!(
        "from=\"{}\" {blob} {} {email}",
        cfg.console_from, cfg.key_marker
    )
}

/// The entry a member should have, keeping what is already there (any
/// setting an admin changed, and the key). `None` when `existing` already is
/// that entry. `key` is the private key to use when `existing` has none.
pub fn member_entry(
    cfg: &WorkbenchConfig,
    user: &str,
    existing: Option<&AddressBookEntry>,
    key: impl FnOnce() -> String,
) -> Option<AddressBookEntry> {
    let display = format!("{} ({user})", cfg.host_label());
    if let Some(e) = existing {
        let ok = e.session_type == "ssh"
            && e.hostname.as_deref() == Some(cfg.host.as_str())
            && e.port.unwrap_or(22) == cfg.port
            && e.username.as_deref() == Some(user)
            && e.tmux == Some(true)
            && e.private_key.as_deref().is_some_and(|k| !k.is_empty())
            && e.display_name.as_deref() == Some(display.as_str());
        if ok {
            return None;
        }
    }
    let mut e = existing.cloned().unwrap_or_else(|| {
        serde_json::from_value(serde_json::json!({
            "type": "ssh",
            "enable_recording": true,
            "fullscreen_on_connect": true,
        }))
        .expect("a minimal ssh entry")
    });
    e.session_type = "ssh".into();
    e.hostname = Some(cfg.host.clone());
    e.port = Some(cfg.port);
    e.username = Some(user.to_string());
    e.tmux = Some(true);
    e.display_name = Some(display);
    e.password = None;
    e.prompt_credentials = None;
    if e.private_key.as_deref().is_none_or(str::is_empty) {
        e.private_key = Some(key());
    }
    Some(e)
}

/// The key changes that make the host match: every member's console key is
/// exactly `want[user]`, and nobody outside the group has one.
pub fn host_actions(
    survey: &Survey,
    want: &BTreeMap<String, String>,
    remove_departed: bool,
) -> Vec<HostAction> {
    let mut out = Vec::new();
    for (user, line) in want {
        let Some(blob) = key_blob(line) else { continue };
        let have = survey.keys.get(user).map(Vec::as_slice).unwrap_or(&[]);
        if have.len() != 1 || have[0] != blob {
            out.push(HostAction::Install {
                user: user.clone(),
                line: line.clone(),
            });
        }
    }
    if remove_departed {
        for user in survey.keys.keys() {
            if !survey.members.contains(user) && !want.contains_key(user) {
                out.push(HostAction::Remove { user: user.clone() });
            }
        }
    }
    out
}

/// The managed folders whose person is no longer a member. A folder counts
/// as managed only when its key has the prefix and its config gives exactly
/// one of our emails and no group, so nothing else is ever removed.
pub fn departed_folders(
    cfg: &WorkbenchConfig,
    members: &BTreeSet<String>,
    folders: &[(String, FolderConfig)],
) -> Vec<String> {
    folders
        .iter()
        .filter(|(name, c)| {
            name.starts_with(&cfg.folder_prefix)
                && c.allowed_groups.is_empty()
                && c.allowed_users.len() == 1
                && cfg.user_of(&c.allowed_users[0]).is_some_and(|u| {
                    !members.contains(&u) && cfg.folder_of(&c.allowed_users[0]) == *name
                })
        })
        .map(|(n, _)| n.clone())
        .collect()
}

/// The members a work bench is made for: those that map to an email.
/// Others (service accounts) are reported and skipped.
pub fn member_plan(
    cfg: &WorkbenchConfig,
    members: &BTreeSet<String>,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    for u in members {
        match cfg.email_of(u) {
            Some(email) => ok.push((u.clone(), email)),
            None => skipped.push(u.clone()),
        }
    }
    (ok, skipped)
}

// ── Running it ──

/// What one sync did (or, dry, would do).
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub dry_run: bool,
    pub members: Vec<String>,
    pub skipped_members: Vec<String>,
    pub folders_written: Vec<String>,
    pub entries_written: Vec<String>,
    pub keys_generated: Vec<String>,
    pub host: Vec<HostAction>,
    pub host_failures: BTreeMap<String, String>,
    pub folders_removed: Vec<String>,
    pub errors: Vec<String>,
}

fn new_private_key() -> Result<(String, String), String> {
    let k =
        ssh_key::PrivateKey::random(&mut ssh_key::rand_core::OsRng, ssh_key::Algorithm::Ed25519)
            .map_err(|e| e.to_string())?;
    let pem = k
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    let public = k.public_key().to_openssh().map_err(|e| e.to_string())?;
    Ok((pem, public))
}

/// `type base64` of a stored private key's public half.
pub fn public_blob(private_pem: &str) -> Option<String> {
    let k = ssh_key::PrivateKey::from_openssh(private_pem.trim()).ok()?;
    key_blob(&k.public_key().to_openssh().ok()?)
}

/// One sync against `vault` and the host. Dry: read everything, write
/// nothing, and report what would change.
pub async fn sync(
    cfg: &WorkbenchConfig,
    vault: &crate::api::VaultBackends,
    dry_run: bool,
) -> Report {
    let mut r = Report {
        dry_run,
        ..Default::default()
    };
    if let Err(e) = cfg.check() {
        r.errors.push(e);
        return r;
    }
    let (ascope, afolder, aentry) = cfg.admin_entry_parts().expect("checked");
    let admin = match crate::api::system_entry(vault, ascope, afolder, aentry).await {
        Ok(e) => e,
        Err(e) => {
            r.errors
                .push(format!("admin_entry {}: {e}", cfg.admin_entry));
            return r;
        }
    };
    let run = |command: String| {
        let admin = admin.clone();
        async move {
            crate::api::run_on_entry(&admin, &command, std::time::Duration::from_secs(60)).await
        }
    };

    // 1. Who is in the group, and what keys the host has.
    let survey = match run(survey_command(&cfg.group, &cfg.key_marker).expect("checked")).await {
        Ok(out) => match parse_survey(&out.stdout) {
            Some(s) => s,
            None => {
                r.errors.push(format!(
                    "the host's survey was not understood: {}",
                    out.stderr.lines().next().unwrap_or("").trim()
                ));
                return r;
            }
        },
        Err(e) => {
            r.errors.push(format!("the host could not be asked: {e}"));
            return r;
        }
    };
    if survey.members.is_empty() {
        // An empty group is far more likely a lookup failure than everyone
        // leaving at once: change nothing.
        r.errors.push(format!(
            "group {} has no members on the host; nothing changed",
            cfg.group
        ));
        return r;
    }
    let (members, skipped) = member_plan(cfg, &survey.members);
    r.members = members.iter().map(|(u, _)| u.clone()).collect();
    r.skipped_members = skipped;

    // 2. Each member's folder and entry, and the key the host should have.
    let entry_name = cfg.entry_name();
    let mut want: BTreeMap<String, String> = BTreeMap::new();
    for (user, email) in &members {
        let folder = cfg.folder_of(email);
        let desired = cfg.folder_config(email, user);
        match vault.get_folder_config(&cfg.scope, &folder).await {
            Ok(c) if c == desired => {}
            Ok(_) | Err(crate::vault::VaultError::NotFound) => {
                r.folders_written.push(folder.clone());
                if !dry_run {
                    if let Err(e) = vault.put_folder_config(&cfg.scope, &folder, &desired).await {
                        r.errors.push(format!("{folder}: writing the folder: {e}"));
                        continue;
                    }
                }
            }
            Err(e) => {
                r.errors.push(format!("{folder}: reading the folder: {e}"));
                continue;
            }
        }
        let existing = match vault.get_entry(&cfg.scope, &folder, &entry_name).await {
            Ok(e) => e.pick_protocol(None).map(|(_, e)| e),
            Err(crate::vault::VaultError::NotFound) => None,
            Err(e) => {
                r.errors.push(format!("{folder}: reading the entry: {e}"));
                continue;
            }
        };
        let mut generated: Option<String> = None;
        let mut keygen_err = None;
        let updated = member_entry(cfg, user, existing.as_ref(), || match new_private_key() {
            Ok((pem, _)) => {
                generated = Some(pem.clone());
                pem
            }
            Err(e) => {
                keygen_err = Some(e);
                String::new()
            }
        });
        if let Some(e) = keygen_err {
            r.errors.push(format!("{folder}: generating a key: {e}"));
            continue;
        }
        if generated.is_some() {
            r.keys_generated.push(user.clone());
        }
        let entry = match updated {
            Some(e) => {
                r.entries_written.push(format!("{folder}/{entry_name}"));
                if !dry_run {
                    if let Err(err) = vault
                        .put_entry(&cfg.scope, &folder, &entry_name, &e.clone().compact())
                        .await
                    {
                        r.errors.push(format!("{folder}: writing the entry: {err}"));
                        continue;
                    }
                }
                e
            }
            None => existing.expect("unchanged means it exists"),
        };
        match entry.private_key.as_deref().and_then(public_blob) {
            Some(blob) => {
                want.insert(user.clone(), key_line(cfg, &blob, email));
            }
            None if dry_run && generated.is_some() => {
                want.insert(user.clone(), key_line(cfg, "ssh-ed25519 (new)", email));
            }
            None => r.errors.push(format!(
                "{folder}: the stored key is not an OpenSSH private key"
            )),
        }
    }

    // 3. The host's keys.
    r.host = host_actions(&survey, &want, cfg.remove_departed);
    if !r.host.is_empty() && !dry_run {
        let cmd = apply_command(&cfg.group, &cfg.key_marker, &r.host).expect("checked names");
        match run(cmd).await {
            Ok(out) => match parse_apply(&out.stdout) {
                Some(res) => {
                    for (u, v) in res {
                        if let Err(why) = v {
                            r.host_failures.insert(u, why);
                        }
                    }
                }
                None => r
                    .errors
                    .push("the host's reply to the key changes was not understood".into()),
            },
            Err(e) => r.errors.push(format!("writing keys on the host: {e}")),
        }
    }

    // 4. Folders of people who left.
    if cfg.remove_departed {
        match vault.list_folders_in_scope(&cfg.scope).await {
            Ok(list) => {
                let mut folders = Vec::new();
                for f in list
                    .into_iter()
                    .filter(|f| f.name.starts_with(&cfg.folder_prefix))
                {
                    if let Ok(c) = vault.get_folder_config(&cfg.scope, &f.name).await {
                        folders.push((f.name, c));
                    }
                }
                for name in departed_folders(cfg, &survey.members, &folders) {
                    r.folders_removed.push(name.clone());
                    if !dry_run {
                        if let Err(e) = vault.delete_folder(&cfg.scope, &name).await {
                            r.errors.push(format!("{name}: removing the folder: {e}"));
                        }
                    }
                }
            }
            Err(e) => r.errors.push(format!("listing folders: {e}")),
        }
    }
    r
}

/// Whether a report changed anything (or, dry, would).
pub fn changed(r: &Report) -> bool {
    !(r.folders_written.is_empty()
        && r.entries_written.is_empty()
        && r.host.is_empty()
        && r.folders_removed.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> WorkbenchConfig {
        toml::from_str(
            r#"
            host = "192.0.2.10"
            host_label = "bench.example.com"
            group = "bench-users"
            admin_entry = "shared/staff/bench.example.com"
            console_from = "198.51.100.7"
            user_suffix = "-example.com"
            email_domain = "example.com"
            key_marker = "console.example.com"
            "#,
        )
        .unwrap()
    }

    const MARK: &str = "console.example.com";

    #[test]
    fn without_a_suffix_the_unix_user_is_the_local_part_and_the_marker_is_checked() {
        let mut c = cfg();
        c.user_suffix = String::new();
        assert!(c.check().is_ok());
        assert_eq!(c.email_of("alice").as_deref(), Some("alice@example.com"));
        assert_eq!(c.user_of("alice@example.com").as_deref(), Some("alice"));
        c.email_domain = String::new();
        assert!(c.check().is_err(), "email_domain is required");
        let mut c = cfg();
        for bad in ["", "a b", "x'y", "$(id)"] {
            c.key_marker = bad.into();
            assert!(c.check().is_err(), "{bad:?}");
            assert!(survey_command("bench-users", bad).is_none());
            assert!(apply_command("bench-users", bad, &[]).is_none());
        }
    }

    #[test]
    fn names_map_both_ways_and_match_the_existing_folders() {
        let c = cfg();
        assert!(c.check().is_ok());
        assert_eq!(
            c.email_of("alice-example.com").as_deref(),
            Some("alice@example.com")
        );
        assert_eq!(c.email_of("svc-sync"), None);
        assert_eq!(c.email_of("-example.com"), None);
        assert_eq!(
            c.user_of("ALICE@example.com").as_deref(),
            Some("alice-example.com")
        );
        assert_eq!(c.user_of("x@gmail.com"), None);
        assert_eq!(c.folder_of("alice@example.com"), "wb-alice-example-com");
        assert_eq!(c.entry_name(), "bench.example.com");
        assert_eq!(
            c.admin_entry_parts(),
            Some(("shared", "staff", "bench.example.com"))
        );
        let f = c.folder_config("alice@example.com", "alice-example.com");
        assert_eq!(f.display_name, "Work Bench - alice@example.com");
        assert_eq!(f.allowed_users, ["alice@example.com"]);
        assert!(f.allowed_groups.is_empty() && !f.inherit_from_parent);
    }

    #[test]
    fn a_bad_config_is_refused() {
        let mut c = cfg();
        c.console_from = "1.2.3.4\" command=\"x".into();
        assert!(c.check().is_err());
        let mut c = cfg();
        c.group = "a b".into();
        assert!(c.check().is_err());
        let mut c = cfg();
        c.admin_entry = "staff".into();
        assert!(c.check().is_err());
    }

    #[test]
    fn survey_reads_members_and_marked_keys() {
        let out = "motd\n@@wb-group carol-example.com,alice-example.com,bob-example.com\n\
            @@wb-key alice-example.com from=\"198.51.100.7\" ssh-ed25519 AAAAsl console.example.com alice@example.com\n\
            @@wb-key old-example.com ssh-ed25519 AAAAold console.example.com old@example.com\n\
            @@wb-done\n";
        let s = parse_survey(out).unwrap();
        assert_eq!(s.members.len(), 3);
        assert_eq!(s.keys["alice-example.com"], ["ssh-ed25519 AAAAsl"]);
        assert_eq!(s.keys["old-example.com"], ["ssh-ed25519 AAAAold"]);
        assert_eq!(parse_survey("@@wb-group a\n"), None);
    }

    #[test]
    fn commands_are_one_quoted_word_and_carry_lines_as_base64() {
        let s = survey_command("bench-users", MARK).unwrap();
        assert_eq!(s.matches('\'').count(), 2);
        assert!(survey_command("a;b", MARK).is_none());
        let a = apply_command(
            "bench-users",
            MARK,
            &[
                HostAction::Install {
                    user: "alice-example.com".into(),
                    line: "from=\"1.2.3.4\" ssh-ed25519 AAAA console.example.com alice@example.com"
                        .into(),
                },
                HostAction::Remove {
                    user: "old-example.com".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(a.matches('\'').count(), 2);
        assert!(!a.contains("1.2.3.4"));
        assert!(a.contains("wb_set \"old-example.com\" \"-\""));
        assert!(apply_command(
            "bench-users",
            MARK,
            &[HostAction::Remove {
                user: "$(id)".into()
            }]
        )
        .is_none());
    }

    #[test]
    fn host_actions_install_missing_or_wrong_keys_and_remove_departed() {
        let c = cfg();
        let survey = Survey {
            members: ["alice-example.com", "bob-example.com", "carol-example.com"]
                .map(String::from)
                .into(),
            keys: [
                (
                    "alice-example.com".to_string(),
                    vec!["ssh-ed25519 AAAAsl".to_string()],
                ),
                (
                    "bob-example.com".to_string(),
                    vec!["ssh-ed25519 AAAAstale".to_string()],
                ),
                (
                    "old-example.com".to_string(),
                    vec!["ssh-ed25519 AAAAold".to_string()],
                ),
            ]
            .into(),
        };
        let want: BTreeMap<String, String> = [
            ("alice-example.com", "ssh-ed25519 AAAAsl"),
            ("bob-example.com", "ssh-ed25519 AAAAbn"),
            ("carol-example.com", "ssh-ed25519 AAAAjs"),
        ]
        .into_iter()
        .map(|(u, b)| (u.to_string(), key_line(&c, b, &c.email_of(u).unwrap())))
        .collect();
        let acts = host_actions(&survey, &want, true);
        let ops: Vec<_> = acts
            .iter()
            .map(|a| match a {
                HostAction::Install { user, .. } => format!("install {user}"),
                HostAction::Remove { user } => format!("remove {user}"),
            })
            .collect();
        assert_eq!(
            ops,
            [
                "install bob-example.com",
                "install carol-example.com",
                "remove old-example.com"
            ]
        );
        assert!(host_actions(&survey, &want, false)
            .iter()
            .all(|a| matches!(a, HostAction::Install { .. })));
        // Already right: nothing to do.
        let done = Survey {
            members: survey.members.clone(),
            keys: want
                .iter()
                .map(|(u, l)| (u.clone(), vec![key_blob(l).unwrap()]))
                .collect(),
        };
        assert!(host_actions(&done, &want, true).is_empty());
        assert_eq!(
            key_line(&c, "ssh-ed25519 AAAA", "alice@example.com"),
            "from=\"198.51.100.7\" ssh-ed25519 AAAA console.example.com alice@example.com"
        );
    }

    #[test]
    fn only_managed_folders_of_people_who_left_are_removed() {
        let c = cfg();
        let members: BTreeSet<String> = ["alice-example.com".to_string()].into();
        let fc = |users: &[&str], groups: &[&str]| FolderConfig {
            allowed_users: users.iter().map(|s| s.to_string()).collect(),
            allowed_groups: groups.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        let folders = vec![
            (
                "wb-alice-example-com".to_string(),
                fc(&["alice@example.com"], &[]),
            ),
            (
                "wb-bob-example-com".to_string(),
                fc(&["bob@example.com"], &[]),
            ),
            ("wb-shared".to_string(), fc(&[], &["bench-users"])),
            (
                "wb-x-example-com".to_string(),
                fc(&["bob@example.com"], &[]),
            ), // name does not match
            (
                "wb-two".to_string(),
                fc(&["a@example.com", "b@example.com"], &[]),
            ),
            ("staff".to_string(), fc(&["bob@example.com"], &[])),
        ];
        assert_eq!(
            departed_folders(&c, &members, &folders),
            ["wb-bob-example-com"]
        );
    }

    #[test]
    fn member_entry_creates_then_keeps_the_key_and_admin_settings() {
        let c = cfg();
        let e = member_entry(&c, "alice-example.com", None, || "KEY".into()).unwrap();
        assert_eq!(e.session_type, "ssh");
        assert_eq!(e.username.as_deref(), Some("alice-example.com"));
        assert_eq!(e.hostname.as_deref(), Some("192.0.2.10"));
        assert_eq!(e.tmux, Some(true));
        assert_eq!(e.private_key.as_deref(), Some("KEY"));
        assert_eq!(
            e.display_name.as_deref(),
            Some("bench.example.com (alice-example.com)")
        );
        // The same again: nothing to write, no key asked for.
        assert!(member_entry(&c, "alice-example.com", Some(&e), || panic!("no new key")).is_none());
        // tmux turned off by hand is put back, the key and recording kept.
        let mut off = e.clone();
        off.tmux = None;
        off.enable_recording = Some(false);
        let fixed =
            member_entry(&c, "alice-example.com", Some(&off), || panic!("no new key")).unwrap();
        assert_eq!(fixed.tmux, Some(true));
        assert_eq!(fixed.private_key.as_deref(), Some("KEY"));
        assert_eq!(fixed.enable_recording, Some(false));
    }

    #[test]
    fn a_generated_key_round_trips_to_its_public_blob() {
        let (pem, public) = new_private_key().unwrap();
        assert_eq!(public_blob(&pem), key_blob(&public));
        assert!(public_blob("not a key").is_none());
    }

    #[test]
    fn service_accounts_are_skipped() {
        let c = cfg();
        let m: BTreeSet<String> = ["alice-example.com", "svc-x"].map(String::from).into();
        let (ok, skipped) = member_plan(&c, &m);
        assert_eq!(
            ok,
            [(
                "alice-example.com".to_string(),
                "alice@example.com".to_string()
            )]
        );
        assert_eq!(skipped, ["svc-x"]);
    }

    #[test]
    fn apply_output_is_read_per_user() {
        let out = "@@wb-ok alice-example.com\n@@wb-fail bob-example.com not_member\n@@wb-done\n";
        let r = parse_apply(out).unwrap();
        assert_eq!(r["alice-example.com"], Ok(()));
        assert_eq!(r["bob-example.com"], Err("not_member".into()));
        assert_eq!(parse_apply("@@wb-ok a\n"), None);
    }

    #[test]
    fn apply_script_rewrites_only_marked_lines_on_a_real_shell() {
        // The real script under sh, with getent/id/chown/install/
        // mkhomedir_helper shimmed to a temporary tree: alice-example.com (member,
        // has a home with an old console key and a personal key), carol-example.com
        // (member, no home yet), old-example.com (left the group), and
        // x-example.com (not a member).
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("rg-wb-test-{}", std::process::id()));
        let bin = root.join("bin");
        let home = root.join("home");
        std::fs::create_dir_all(&bin).unwrap();
        for u in ["alice-example.com", "old-example.com"] {
            std::fs::create_dir_all(home.join(u).join(".ssh")).unwrap();
        }
        std::fs::write(
            home.join("alice-example.com/.ssh/authorized_keys"),
            "ssh-ed25519 AAAApersonal me@laptop\nfrom=\"1.1.1.1\" ssh-ed25519 AAAAold console.example.com alice@example.com\n",
        )
        .unwrap();
        std::fs::write(
            home.join("old-example.com/.ssh/authorized_keys"),
            "from=\"1.1.1.1\" ssh-ed25519 AAAAgone console.example.com old@example.com\n",
        )
        .unwrap();
        let h = home.to_str().unwrap();
        let shims = [
            ("getent", format!(
                "#!/bin/sh\nif [ \"$1\" = group ]; then echo \"bench-users:x:1:alice-example.com,carol-example.com\"; exit 0; fi\n\
                 case \"$2\" in alice-example.com|carol-example.com|old-example.com|x-example.com) echo \"$2:x:1:1::{h}/$2:/bin/sh\";; *) exit 2;; esac\n")),
            ("id", "#!/bin/sh\necho 1000\n".to_string()),
            ("chown", "#!/bin/sh\nexit 0\n".to_string()),
            ("install", "#!/bin/sh\nshift 7; mkdir -p \"$1\"\n".to_string()),
            ("mkhomedir_helper", format!("#!/bin/sh\nmkdir -p \"{h}/$1\"\n")),
        ];
        for (n, body) in shims {
            let p = bin.join(n);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let new_line = |u: &str| {
            format!("from=\"198.51.100.7\" ssh-ed25519 AAAAnew{u} console.example.com {u}")
        };
        let cmd = apply_command(
            "bench-users",
            MARK,
            &[
                HostAction::Install {
                    user: "alice-example.com".into(),
                    line: new_line("sl"),
                },
                HostAction::Install {
                    user: "carol-example.com".into(),
                    line: new_line("js"),
                },
                HostAction::Install {
                    user: "x-example.com".into(),
                    line: new_line("x"),
                },
                HostAction::Remove {
                    user: "old-example.com".into(),
                },
            ],
        )
        .unwrap();
        let script = &cmd["sh -c '".len()..cmd.len() - 1];
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let out = std::process::Command::new("sh")
            .env("PATH", path)
            .args(["-c", script])
            .output()
            .unwrap();
        let res = parse_apply(&String::from_utf8_lossy(&out.stdout));
        let read = |u: &str| {
            std::fs::read_to_string(home.join(u).join(".ssh/authorized_keys")).unwrap_or_default()
        };
        let (sl, js, old) = (
            read("alice-example.com"),
            read("carol-example.com"),
            read("old-example.com"),
        );
        let x_exists = home.join("x-example.com").exists();
        let _ = std::fs::remove_dir_all(&root);
        let res = res.expect("output understood");
        assert_eq!(res["alice-example.com"], Ok(()));
        assert_eq!(res["carol-example.com"], Ok(()));
        assert_eq!(res["x-example.com"], Err("not_member".into()));
        assert_eq!(res["old-example.com"], Ok(()));
        assert_eq!(
            sl,
            format!("ssh-ed25519 AAAApersonal me@laptop\n{}\n", new_line("sl"))
        );
        assert_eq!(js, format!("{}\n", new_line("js")));
        assert_eq!(old, "");
        assert!(!x_exists, "nothing is created for a non-member");
    }
}
