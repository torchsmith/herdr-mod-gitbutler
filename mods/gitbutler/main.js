import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, notify, props } from "herdr";

// GitButler panel: the `but` CLI's workspace (uncommitted changes, applied
// branches and their commits) beside the terminals, with commit, push, pull,
// absorb and undo. Everything goes through `but ... --json`.

// props().folder pins the panel to one repo (a pane or window); else it follows focus.
function location() {
  const pinned = props()?.folder;
  if (pinned) return { cwd: pinned, on: props().machine ?? null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const firstLine = (s) => (s ?? "").split("\n")[0];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Recent (under a week): "just now", "5m ago", "3h ago", "2d ago". Older: "Oct 23", "Oct 23, 2025".
function when(iso) {
  const d = new Date(iso), ms = Date.now() - d.getTime();
  if (isNaN(ms)) return "";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), days = Math.floor(h / 24);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (days < 7) return `${days}d ago`;
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}
// Git refuses spaces and a few symbols in branch names.
const branchName = (s) => s.trim().replace(/\s+/g, "-").replace(/[~^:?*\[\\]+/g, "");
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const STATUS = { added: "A", modified: "M", deleted: "D", renamed: "R", conflicted: "U" };
const BRANCH = {
  completelyUnpushed: "local", nothingToPush: "pushed", unpushedCommits: "ahead",
  unpushedCommitsRequiringForce: "force", integrated: "merged",
};

// `but diff --json` → numbered rows; a file header row ("f") between files.
function diffRows(changes) {
  const rows = [];
  for (const c of changes) {
    if (changes.length > 1) rows.push({ kind: "f", text: `${STATUS[c.status] ?? "?"}  ${c.path}` });
    const d = c.diff ?? {};
    if (d.type !== "patch") { rows.push({ kind: "", text: d.type === "binary" ? "Binary file" : d.type ? `No text diff (${d.type})` : "No text diff" }); continue; }
    for (const h of d.hunks ?? []) {
      let old = h.oldStart, next = h.newStart;
      for (const line of h.diff.replace(/\n$/, "").split("\n")) {
        if (line.startsWith("@@")) { rows.push({ kind: "@", text: line }); continue; }
        const kind = line[0], text = (untab(line.slice(1)) || " ").slice(0, 4000);
        if (kind === "-") rows.push({ kind, number: old++, text });
        else if (kind === "+") rows.push({ kind, number: next++, text });
        else if (kind === " ") { old++; rows.push({ kind, number: next++, text }); }
        else rows.push({ kind: "", text: line });
      }
      if (rows.length > 3000) { rows.push({ kind: "", text: "… diff truncated" }); return rows; }
    }
  }
  return rows;
}

export default class GitButler extends View {
  init(_props, cx) {
    this.reset(); this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.nameInput = InputState.new({ placeholder: "new-branch-name" });
    this.nameInput.on("submit", (_e, cx) => this.chooseNew(cx));
    this.nameInput.on("focus", (_e, cx) => { this.naming = true; cx.notify(); });
    this.nameInput.on("blur", (_e, cx) => { this.naming = false; cx.notify(); });
    this.refresh(cx);
    // Relative times ("5m ago") age; redraw once a minute, not faster.
    cx.timer.every(60000, (cx) => cx.notify());
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  reset() {
    this.root = null; this.status = null; this.files = []; this.branches = []; this.open = null;
    this.rows = []; this.diffWidth = 0; this.message = ""; this.input?.set_value("");
    this.selected = new Set(); this.target = null; this.error = null; this.note = null; this.watched = null;
    this.plain = false; this.enable = false; this.newBranch = null; this.menu = false;
  }

  but(args) { return exec("but", args, { cwd: this.root, on: this.on, timeout: 120000 }); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const paths = await watchFolder(root);
          // `but` writes its own state under .git; only working-tree edits matter.
          if (this.watched === root && paths.some((p) => !p.includes("/.git/") && !p.endsWith("/.git"))) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.reset(); this.error = "Not a git repository"; return; }
        this.root = top.stdout.trim(); this.on = on;
        // `but status` turns a plain repo into a GitButler one: only run it where
        // GitButler already is, or once the person clicks Enable.
        if (!this.enable) {
          const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: this.root, on });
          const marker = common.code === 0 ? await exec("test", ["-d", `${common.stdout.trim()}/gitbutler`], { on }) : { code: 1 };
          if (key() !== context) return;
          if (marker.code !== 0) { this.status = null; this.files = []; this.branches = []; this.plain = true; this.error = "Not a GitButler project"; return; }
        }
        this.plain = false;
        const r = await this.but(["status", "--json"]);
        if (key() !== context) return;
        if (r.code !== 0) {
          this.status = null; this.files = []; this.branches = [];
          this.error = (r.stderr || r.stdout).trim().split("\n")[0] || "Not a GitButler workspace";
          return;
        }
        const s = JSON.parse(r.stdout);
        const files = (s.uncommittedChanges ?? []).map((c) => ({ id: c.cliId, path: c.filePath, status: c.changeType, branch: null }));
        const branches = [];
        for (const stack of s.stacks ?? []) {
          for (const c of stack.assignedChanges ?? []) files.push({ id: c.cliId, path: c.filePath, status: c.changeType, branch: stack.branches?.[0]?.name ?? null });
          stack.branches.forEach((b, i) => branches.push({ ...b, stack: stack.cliId, stacked: i > 0 }));
        }
        this.status = s; this.files = files; this.branches = branches; this.error = null;
        for (const p of [...this.selected]) if (!files.some((f) => f.path === p)) this.selected.delete(p);
        if (this.newBranch === null && !branches.some((b) => b.name === this.target)) {
          this.target = branches[0]?.name ?? null;
          if (!branches.length) this.newBranch = "";
        }
        this.watch(this.root, cx);
        if (this.open?.kind === "file" && !files.some((f) => f.path === this.open.path)) this.open = null;
        if (this.open?.kind === "commit" && !branches.some((b) => b.commits.some((c) => c.commitId === this.open.id))) this.open = null;
        if (!this.open && !this.closed && files.length) this.open = { kind: "file", id: files[0].id, path: files[0].path };
        if (this.open) await this.load(this.open, context);
        else this.setRows([]);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(open, context) {
    // File cliIds change after every mutation; a path is stable, commits use their hash.
    const target = open.kind === "file" ? (this.files.find((f) => f.path === open.path)?.id ?? open.path) : open.id;
    const r = await this.but(["diff", "--json", target]);
    if (key() !== context || this.open !== open) return;
    if (r.code !== 0) { this.setRows([{ kind: "", text: (r.stderr || r.stdout).trim() || "Cannot show this diff" }]); return; }
    try { this.setRows(diffRows(JSON.parse(r.stdout).changes ?? [])); }
    catch { this.setRows([{ kind: "", text: "Cannot preview this diff (too large or unreadable)" }]); }
  }

  setRows(rows) {
    this.rows = rows;
    this.diffWidth = Math.max(300, ...rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(open, cx) {
    const same = this.open && this.open.kind === open.kind && (open.kind === "file" ? this.open.path === open.path : this.open.id === open.id);
    this.open = same ? null : open; this.closed = same; this.setRows([]); this.note = null;
    const context = this.context, now = this.open;
    if (now) cx.spawn(async (cx) => {
      try { await this.load(now, context); } catch (e) { this.note = `Cannot show diff: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // Runs one mutating `but` command, shows its error, then refreshes.
  act(label, args, cx, after) {
    if (!this.root || this.busy || this.context !== key()) return;
    const context = this.context;
    this.busy = label; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.but(args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("\n"));
        if (key() === context) after?.(r);
      } catch (e) { if (key() === context) this.note = `${label} failed: ${e.message ?? e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  commit(cx) {
    const message = this.message.trim();
    if (!message || !this.files.length) return;
    const paths = this.files.filter((f) => this.selected.has(f.path)).map((f) => f.path);
    const fresh = this.newBranch;
    const branch = fresh !== null ? (fresh ? ["-b", fresh] : ["-b"]) : ["-b", this.target];
    this.act("Commit", ["commit", "-m", message, ...branch, ...paths], cx, () => {
      this.message = ""; this.input.set_value(""); this.selected.clear();
      // A named new branch now exists: keep committing to it. An auto-named one
      // is unknown here, so the next refresh falls back to the first branch.
      if (fresh !== null) { this.target = fresh || null; this.newBranch = null; this.nameInput.set_value(""); }
    });
  }

  push(b, cx) {
    this.act("Push", ["push", b.name], cx, () => notify({ title: "Pushed", body: b.name, level: "success", timeout: 3000 }));
  }

  chooseBranch(name, cx) {
    this.target = name; this.newBranch = null; this.menu = false; cx.notify();
  }

  chooseNew(cx) {
    const name = branchName(this.nameInput.value());
    // An existing name just picks that branch.
    if (name && this.branches.some((b) => b.name === name)) return this.chooseBranch(name, cx);
    this.newBranch = name; this.menu = false; this.handle.focus(); cx.notify();
  }

  toggleMenu(cx) {
    // The press that closed it (outside the menu) lands on the chip too.
    if (!this.menu && Date.now() - (this.menuClosed ?? 0) < 250) return;
    this.menu = !this.menu;
    if (this.menu) { this.nameInput.set_value(this.newBranch ?? ""); }
    cx.notify();
  }

  branchMenu(t) {
    const rows = this.branches.map((b) => {
      const on = this.newBranch === null && this.target === b.name;
      return h_flex().id(`pick-${b.name}`).h(28).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.chooseBranch(b.name, cx))
        .child(div().w(12).flex_none().child(on ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent) : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(b.stacked ? `↳ ${b.name}` : b.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`${b.commits.length} commit${b.commits.length === 1 ? "" : "s"}`));
    });
    const listHeight = Math.min(240, Math.max(1, rows.length) * 28 + 8);
    return v_flex().id("branch-menu").absolute().left(10).right(10).bottom(88).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { if (this.menu) { this.menu = false; this.menuClosed = Date.now(); cx.notify(); } })
      .child(div().px(10).pt(8).pb(4).text_size(10).text_color(t.dim).child("COMMIT TO BRANCH"))
      .child(div().h(listHeight).flex_none().relative()
        .child(v_flex().id("branch-menu-list").absolute().top(0).bottom(0).left(4).right(4).overflow_y_scroll().py(4).children(rows)
          .when(!rows.length, (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child("No applied branches"))))
        .child(Scrollbar.vertical("branch-menu-list").absolute().inset_0()))
      .child(v_flex().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(10).text_color(t.dim).child("NEW BRANCH"))
        .child(h_flex().gap(6)
          .child(div().id("branch-name").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(this.naming ? t.accent : t.border).cursor_text()
            .child(Input.new(this.nameInput).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button("branch-new", "Use", t, (cx) => this.chooseNew(cx), { primary: true })))
        .child(div().text_size(10).text_color(t.dim).child("Leave empty for a generated name.")));
  }

  // ---------- view ----------

  button(id, label, t, onClick, { primary = false, enabled = true } = {}) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(11)
      .bg(primary && enabled ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  section(label, t, extra) {
    return h_flex().h(24).flex_none().px(8).mt(4).gap(6).items_center().text_size(10).text_color(t.dim).child(div().child(label.toUpperCase())).when(Boolean(extra), (e) => e.child(extra));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), letter = STATUS[f.status] ?? "?";
    const checked = this.selected.has(f.path), open = this.open?.kind === "file" && this.open.path === f.path;
    return h_flex().id(`file-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick({ kind: "file", id: f.id, path: f.path }, cx))
      .child(div().id(`check-${f.path}`).size(13).flex_none().rounded(3).border_1().border_color(checked ? t.accent : t.input).bg(checked ? t.accent : t.background)
        .flex().items_center().justify_center().text_size(9).text_color(t.accent_foreground)
        .on_click((_e, cx) => { cx.stop_propagation(); checked ? this.selected.delete(f.path) : this.selected.add(f.path); cx.notify(); })
        .child(checked ? svg("mods/workspace-chrome/check.svg").size(10) : ""))
      .child(div().w(12).text_size(11).text_color(letter === "A" ? t.ansi2 : letter === "D" || letter === "U" ? t.ansi1 : t.blocked).child(letter))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(240).min_w(0).truncate().child(name)))
      .when(Boolean(f.branch), (e) => e.child(div().max_w(90).truncate().text_size(10).text_color(t.muted).child(f.branch)))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(f.id));
  }

  branchRows(b, t) {
    const state = BRANCH[b.branchStatus] ?? b.branchStatus;
    const canPush = state !== "pushed" && state !== "merged" && b.commits.length > 0;
    const rows = [h_flex().id(`branch-${b.name}`).h(28).flex_none().px(8).gap(7).items_center()
      .child(svg("mods/workspace-chrome/git-branch.svg").size(13).flex_none().text_color(b.stacked ? t.dim : t.accent))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(b.stacked ? `↳ ${b.name}` : b.name))
      .child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(state === "force" ? t.blocked : t.muted).child(state))
      .when(b.reviewId != null, (e) => e.child(div().text_size(10).text_color(t.muted).child(/^\d+$/.test(String(b.reviewId)) ? `#${b.reviewId}` : String(b.reviewId).replace(/[()]/g, ""))))
      .when(b.upstreamCommits?.length > 0, (e) => e.child(div().text_size(10).text_color(t.blocked).child(`↓${b.upstreamCommits.length}`)))
      .when(canPush, (e) => e.child(this.button(`push-${b.name}`, state === "force" ? "Force push" : "Push", t, (cx) => this.push(b, cx), { enabled: !this.busy })))];
    if (!b.commits.length) rows.push(div().h(22).flex_none().pl(28).text_size(11).text_color(t.dim).child("No commits"));
    for (const c of b.commits) {
      const open = this.open?.kind === "commit" && this.open.id === c.commitId;
      rows.push(h_flex().id(`commit-${c.commitId}`).h(24).flex_none().pl(28).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick({ kind: "commit", id: c.commitId }, cx))
        .child(div().size(6).flex_none().rounded(3).bg(c.conflicted ? t.ansi1 : state === "pushed" ? t.muted : t.accent))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(firstLine(c.message) || "(no message)"))
        .child(div().flex_none().text_size(10).text_color(t.muted).child(when(c.createdAt)))
        .child(div().flex_none().min_w(30).text_right().text_size(10).text_color(t.dim).child(c.cliId)));
    }
    return rows;
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "f") return div().w_full().px(12).h(22).flex_none().truncate().bg(t.surface).border_b(1).border_color(t.border).font_semibold().child(text);
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), s = this.status, behind = s?.upstreamState?.behind ?? 0, busy = Boolean(this.busy);
    const listHeight = s ? 24 + Math.max(1, this.files.length) * 26 + 24 + this.branches.reduce((n, b) => n + 28 + Math.max(1, b.commits.length) * 24, 0) + 24 : 40;
    const canCommit = Boolean(this.message.trim() && this.files.length && s && !busy && !this.loading && (this.newBranch !== null || this.target));
    const sel = this.selected.size;
    const targetLabel = this.newBranch !== null ? `+ ${this.newBranch || "new branch"}` : this.target ?? "Choose branch";

    const list = [];
    if (s) {
      list.push(this.section("Uncommitted", t, this.files.length ? div().text_size(10).text_color(t.muted).child(sel ? `${sel} of ${this.files.length} selected` : `${this.files.length}`) : null));
      if (this.files.length) list.push(...this.files.map((f) => this.fileRow(f, t)));
      else list.push(div().h(26).px(8).flex_none().flex().items_center().text_color(t.dim).child("No uncommitted changes"));
      list.push(this.section("Branches", t));
      if (!this.branches.length) list.push(div().h(26).px(8).flex_none().flex().items_center().text_color(t.dim).child("No applied branches"));
      for (const b of this.branches) list.push(...this.branchRows(b, t));
    } else {
      list.push(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : "No folder")));
      if (this.plain) list.push(h_flex().px(8).gap(8).items_center()
        .child(div().text_size(11).text_color(t.dim).child("Start tracking this repo with GitButler?"))
        .child(this.button("enable", "Enable", t, (cx) => { this.enable = true; this.refresh(cx); }, { primary: true })));
    }

    const root = v_flex().id("gitbutler").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.menu) { this.menu = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      // Header: title, counts, workspace actions.
      .child(h_flex().h(42).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("GitButler"))
        .child(div().flex_1().min_w(0))
        .when(busy, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)))
        .when(Boolean(s), (e) => e
          .child(this.button("pull", behind ? `Pull ↓${behind}` : "Pull", t, (cx) => this.act("Pull", ["pull"], cx), { enabled: !busy }))
          .child(this.button("absorb", "Absorb", t, (cx) => this.act("Absorb", ["absorb"], cx), { enabled: !busy && this.files.length > 0 }))
          .child(this.button("undo", "Undo", t, (cx) => this.act("Undo", ["undo"], cx), { enabled: !busy }))))
      // Changes and branches.
      .child(div().flex_1().min_h(44).max_h(listHeight + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("gitbutler-list").absolute().top(0).bottom(0).left(6).right(6).overflow_y_scroll().py(6).children(list))
        .child(Scrollbar.vertical("gitbutler-list").absolute().inset_0()))
      // Diff of the picked file or commit.
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("gitbutler-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("gitbutler-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("gitbutler-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && Boolean(s), (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file or commit to view its diff"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      // Commit: target branch chip, message, button.
      .when(Boolean(s), (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().child(sel ? `Commit ${sel} file${sel > 1 ? "s" : ""} to` : "Commit all to"))
          .child(h_flex().id("target").h(22).px(7).gap(4).min_w(0).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
            .when(this.menu, (st) => st.border_color(t.accent)).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.toggleMenu(cx))
            .child(svg("mods/workspace-chrome/git-branch.svg").size(11)).child(div().max_w(200).truncate().text_color(t.foreground).child(targetLabel)).child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(t.dim))))
        .child(h_flex().gap(8)
          .child(div().id("gitbutler-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("gitbutler-commit").h(32).px(14).flex().items_center().rounded(8).bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim).text_size(12)
            .when(canCommit, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy === "Commit" ? "Committing…" : "Commit")))));
    return root.when(this.menu && Boolean(s), (e) => e.child(this.branchMenu(t)));
  }
}
