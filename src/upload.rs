//! Files pasted or dropped into a terminal session.
//!
//! Claude Code reads an image from the clipboard of the machine it runs on,
//! and in the console that is the host, not the person's computer. So the
//! browser sends the image (or a dropped file) here, rustguac saves it on the
//! host as the entry's own login, over SSH with the bytes on stdin, and the
//! page types the saved path into the terminal: Claude Code takes a pasted
//! image path as an attachment, as it does a file dragged into a local
//! terminal.
//!
//! Files go to `~/.cache/console-uploads/<time>-<pid>/<name>`, one folder
//! per upload so names never collide, and folders older than
//! [`KEEP_DAYS`] days are removed on the next upload.

/// Largest file accepted.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// Uploads older than this many days are removed on the next upload.
pub const KEEP_DAYS: u32 = 7;
/// Longest saved file name.
const MAX_NAME: usize = 100;

const SAVED_MARK: &str = "@@rg-saved";
const DONE_MARK: &str = "@@rg-upload-done";

/// A file name safe to put in a path and to type into a terminal unquoted:
/// `A-Z a-z 0-9 . _ -` only (anything else becomes `-`), at most
/// [`MAX_NAME`] characters keeping the extension, never starting with `.`
/// or `-`, and `file` when nothing is left.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut n: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while n.starts_with(['.', '-']) {
        n.remove(0);
    }
    if n.len() > MAX_NAME {
        // Keep the extension, so an image is still an image.
        let ext = n
            .rfind('.')
            .map(|i| n[i..].to_string())
            .filter(|e| e.len() <= 10)
            .unwrap_or_default();
        n.truncate(MAX_NAME - ext.len());
        n.push_str(&ext);
    }
    if n.is_empty() || n.chars().all(|c| c == '.') {
        "file".into()
    } else {
        n
    }
}

/// The command that saves its stdin as `name` under the uploads folder and
/// prints the path, read by [`parse_saved`]. `name` must come from
/// [`clean_name`].
pub fn save_command(name: &str) -> Option<String> {
    if name.is_empty() || clean_name(name) != name {
        return None;
    }
    Some(format!(
        "sh -c 'd=\"$HOME/.cache/console-uploads\"; mkdir -p \"$d\" && chmod 700 \"$d\" || exit 1; \
         find \"$d\" -mindepth 1 -maxdepth 1 -mtime +{KEEP_DAYS} -exec rm -rf {{}} + 2>/dev/null; \
         u=\"$d/$(date +%Y%m%d-%H%M%S)-$$\"; mkdir -p \"$u\" || exit 1; f=\"$u/{name}\"; \
         cat > \"$f\" && echo \"{SAVED_MARK} $f\"; echo {DONE_MARK}'"
    ))
}

/// The saved file's path from [`save_command`]'s output, if it was saved.
pub fn parse_saved(stdout: &str) -> Option<String> {
    let mut path = None;
    for l in stdout.lines() {
        let l = l.trim_end_matches('\r');
        if let Some(p) = l.strip_prefix(SAVED_MARK).and_then(|r| r.strip_prefix(' ')) {
            path = Some(p.to_string());
        }
        if l.trim() == DONE_MARK {
            return path;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe_to_type() {
        assert_eq!(
            clean_name("Screenshot 2026-11-05 at 9.41.03 pm.png"),
            "Screenshot-2026-11-05-at-9.41.03-pm.png"
        );
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("C:\\Users\\x\\a b.txt"), "a-b.txt");
        assert_eq!(clean_name(".bashrc"), "bashrc");
        assert_eq!(clean_name("-rf"), "rf");
        assert_eq!(clean_name("$(id);`x`'\"\n.png"), "id---x----.png");
        assert_eq!(clean_name(""), "file");
        assert_eq!(clean_name("..."), "file");
        assert_eq!(clean_name("ü"), "file");
        let long = format!("{}.jpeg", "a".repeat(300));
        let c = clean_name(&long);
        assert!(c.len() <= MAX_NAME && c.ends_with(".jpeg"));
    }

    #[test]
    fn save_command_takes_only_clean_names() {
        let c = save_command("clipboard.png").unwrap();
        assert_eq!(c.matches('\'').count(), 2);
        assert!(c.contains("f=\"$u/clipboard.png\""));
        assert!(c.contains("-mtime +7"));
        assert!(save_command("a b.png").is_none());
        assert!(save_command("../x").is_none());
        assert!(save_command("").is_none());
    }

    #[test]
    fn saved_path_needs_the_end_mark() {
        assert_eq!(
            parse_saved(
                "motd\n@@rg-saved /root/.cache/console-uploads/1-2/a.png\n@@rg-upload-done\n"
            )
            .as_deref(),
            Some("/root/.cache/console-uploads/1-2/a.png")
        );
        assert_eq!(parse_saved("@@rg-upload-done\n"), None);
        assert_eq!(parse_saved("@@rg-saved /x\n"), None);
    }

    #[test]
    fn save_command_runs_on_a_real_shell() {
        // Through sh with stdin, against a temporary home.
        use std::io::Write;
        let home = std::env::temp_dir().join(format!("rg-upload-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let cmd = save_command("pic.png").unwrap();
        let script = &cmd["sh -c '".len()..cmd.len() - 1];
        let mut child = std::process::Command::new("sh")
            .env("HOME", &home)
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"\x89PNG\r\n\x1a\nbytes")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let path = parse_saved(&String::from_utf8_lossy(&out.stdout)).expect("saved");
        let saved = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_dir_all(&home);
        assert!(path.starts_with(home.to_str().unwrap()));
        assert!(path.ends_with("/pic.png"));
        assert_eq!(saved, b"\x89PNG\r\n\x1a\nbytes");
    }
}
