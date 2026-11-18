/* The startup command for a tmux session started in a repo: the person's
 * own (remembered in this browser), or the console's default
 * (`[tmux] repo_command`) until they set one. Shared by the tmux workspace
 * and the dashboard.
 *
 * Placeholders, filled in per repo and quoted for a shell where needed:
 *   {repo}     the repo folder's name          (rustguac)
 *   {session}  the tmux session's name         (rustguac, or acme-rustguac)
 *   {path}     the folder on the host          (/home/me/GitLab/acme/rustguac)
 *   {rel}      the folder under the repos root (acme/rustguac)
 * So `claude -n {repo}` starts Claude Code named after the repo. */
(function () {
    'use strict';
    var KEY = 'rg-tmux-repo-cmd';
    // One shell word: as it is when plain, single-quoted otherwise.
    function word(v) {
        v = String(v == null ? '' : v);
        if (/^[A-Za-z0-9_.\/][A-Za-z0-9_.\/@+=,:-]*$/.test(v)) return v;
        return "'" + v.replace(/'/g, "'\\''") + "'";
    }
    window.rgRepoCommand = {
        /* The person's own command, or null when they never set one. An
         * empty string is theirs too: "run nothing". */
        own: function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
        set: function (cmd) { try { localStorage.setItem(KEY, String(cmd).trim()); } catch (e) {} },
        /* Back to the console's default. */
        clear: function () { try { localStorage.removeItem(KEY); } catch (e) {} },
        /* The template in force: their own, else the default. */
        template: function (def) { var own = this.own(); return own != null ? own : (def || ''); },
        expand: function (tpl, repo, session) {
            var path = String(repo.path || '').replace(/\/+$/, '');
            var vals = { repo: path.split('/').pop() || repo.name || '', session: session, path: path, rel: repo.rel || '' };
            return String(tpl || '').replace(/\{(repo|session|path|rel)\}/g, function (m, k) { return word(vals[k]); });
        }
    };
})();
