// Modified from Herdr new-menu for Glass Workspace: project-scoped behavior, charcoal surfaces and native transitions.
import { Motion } from "./motion.js";
const motion = new Motion();
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, notify } from "herdr";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    this.entered=false;
    cx.timer.after(20,next=>{this.entered=true;next.notify();});
    this.spaceId=props()?.space??spaces().find(s=>s.active)?.id;
    const machine=spaces().find(s=>s.id===this.spaceId)?.machine;
    const where=machine??"";
    this.agents=shared("new-menu.agents")?.[where]??[];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared("new-menu.agents",{...shared("new-menu.agents"),[where]:this.agents});
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  launch(args) {
    const space=spaces().find(s=>s.id===this.spaceId);
    if(!space){notify({title:"请先打开项目文件夹",level:"warning"});return;}
    run("layout.select",{stack:"work-views",child:"workspace-view"});
    run("space.select",{id:space.id});
    run("tab.new",{...args,space:space.id,folder:shared("shell.project-roots")?.[space.id]||space.folder});
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(8).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => motion.surface(el,id,t))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.id===this.spaceId);
    const folder=space?(shared("shell.project-roots")?.[space.id]||space.folder):undefined;
    const installed = this.agents.filter(a => a.installed);
    const choices = [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    return v_flex().min_h(0).w_full().h(Math.min(491, 167 + Math.max(1, choices.length) * 31)).rounded(12).overflow_hidden().bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").opacity(this.entered?1:0).transition("opacity",{duration:120,easing:"ease-out"}).track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        this.launch({name:agent.name,argv:agent.run});
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "新建终端", () => this.launch({}), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("启动 Agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => this.launch({name:a.name,argv:a.run}), a.installed ? (i < 9 ? String(i + 1) : "") : "未安装", a.installed)))
        .when(this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "无法读取 Agent" : "正在检测 Agent…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "打开项目文件夹…", () => run("glass-shell.project-new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "新建工作树…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "打开工作树…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder, action: "open" } }), "", Boolean(space)));
  }
}
