// Modified from Herdr files for Glass Workspace: project-scoped behavior, charcoal surfaces and native transitions.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { Motion, Presence } from "./motion.js";
const motion = new Motion();
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, nextCommand } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { md: "markdown", mdx: "markdown", ps1: "powershell", py: "python", rs: "rust", sh: "bash", yml: "yaml", ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const previewStyleKey = () => {
  const t=theme();
  return JSON.stringify([settings().font_family,t.ansi1,t.ansi2,t.ansi3,t.ansi4,t.ansi5,t.ansi6,t.muted]);
};

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.presence = new Presence();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.folderErrors = new Map(); this.marks = {};
    this.previewMode="preview"; this.previewGeneration=0; this.treeHidden=false;
    this.refresh(cx);
    this.commands=cx.spawn(async cx=>{
      for(;;){
        let command;try{command=await nextCommand();}catch{return;}
        const name=String(command).replace(/^shell-files\./,"");
        if(name.startsWith("open.")) {
          try {this.show(decodeURIComponent(name.slice(5)),cx);}
          catch {this.error="文件路径格式无效";}
        }
        if(name==="preview-close")this.show(null,cx);
        cx.notify();
      }
    });
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    this.folderErrors.delete(path);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    else {
      // Only a complete parent listing proves that an expanded folder vanished.
      const prefix=path?path+"/":"", dirs=new Set(entries.filter(e=>e.dir).map(e=>e.name));
      for(const folder of [...this.folders]) {
        if(folder.startsWith(prefix)&&!dirs.has(folder.slice(prefix.length).split("/")[0])) {
          this.folders.delete(folder);this.entries.delete(folder);this.pending.delete(folder);this.folderErrors.delete(folder);
        }
      }
    }
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, previewMode:this.previewMode, treeHidden:this.treeHidden });
      const saved = this.saved.get(next);
      this.presence = new Presence();
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.folderErrors = new Map(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
      this.previewMode=saved?.previewMode??"preview";
      this.treeHidden=Boolean(saved?.file&&saved.treeHidden);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          if(path&&!this.folders.has(path))continue;
          try {await this.loadFolder(path, context);}
          catch(e) {
            if(!path)throw e;
            // One unavailable child must not prevent other folders and previews
            // from refreshing. A later refresh retries it.
            if(this.current(context)){this.entries.set(path,[]);this.folderErrors.set(path,String(e.message??e));}
          }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
        if(this.file&&!this.previewLoading)this.loadPreview(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.folderErrors.set(path,String(e.message??e)); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.previewGeneration++;
    this.code?.release(); this.code=null; this.file=path; this.fileError=null;
    this.rawText=null; this.previewText=null; this.previewLoading=false; this.truncated=false;
    this.previewMode="preview";
    if(!path) {this.treeHidden=false;cx?.notify();return;}
    const ext=path.split(".").at(-1).toLowerCase();
    this.markdown=["md","mdx","markdown"].includes(ext);
    this.previewLoading=true;cx?.notify();
    if(cx)this.loadPreview(cx);
  }
  loadPreview(cx) {
    const path=this.file, context=this.context, generation=++this.previewGeneration;
    if(!path||!context)return;
    this.previewLoading=true;
    cx.spawn(async cx=>{
      try {
        const absolute=/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)?path:`${context.cwd}/${path}`;
        const text=await readTextFile(absolute,{on:context.on});
        if(generation!==this.previewGeneration||!this.current(context))return;
        if(text===null)throw new Error("文件不存在或已被移动");
        if(text.includes("\0"))throw new Error("此文件不是文本，暂不支持内嵌预览");
        this.fileError=null;
        const style=previewStyleKey();
        if(this.rawText===text&&this.code&&this.editorStyle===style)return;
        this.rawText=text;this.truncated=text.length>400000;
        this.previewText=text.slice(0,400000);
        this.code?.release();
        const t=theme(),ext=path.split(".").at(-1).toLowerCase();
        this.code=EditorState.new({language:LANG[ext]??ext,readonly:true,
          value:this.previewText,font_family:settings().font_family,font_size:13,
          soft_wrap:this.markdown||["txt","log"].includes(ext),
          syntax:{keyword:t.ansi5,string:t.ansi2,comment:t.muted,function:t.ansi4,type:t.ansi3,number:t.ansi1,constant:t.ansi6}});
        this.editorStyle=style;
      } catch(e) {
        if(generation===this.previewGeneration&&this.current(context)){
          this.code?.release();this.code=null;this.previewText=null;this.rawText=null;
          this.fileError=`无法预览：${String(e.message??e)}`;
        }
      } finally {
        if(generation===this.previewGeneration)this.previewLoading=false;
        cx.notify();
      }
    });
  }
  close() { this.previewGeneration++;this.context=null;this.code?.release(); }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push({id:"file-"+path,height:28,render:()=>h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(6).cursor_pointer().tooltip(entry.dir?entry.name:`预览 ${entry.name}`).when(true,el=>motion.surface(el,"file-"+path,t,this.file===path))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/shell-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/shell-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))});
      if (entry.dir && open) {
        if(this.folderErrors.has(path))out.push({id:"error-"+path,height:22,render:()=>div().pl(26+depth*18).py(2).text_size(11).text_color(t.muted).tooltip(this.folderErrors.get(path)).child("无法读取此目录")});
        else this.rows(path, depth + 1, out, t);
      }
    }
    return out;
  }

  render(cx) {
    if(key()!==this.context?.key)this.refresh(cx);
    if(this.code&&!this.previewLoading&&this.editorStyle!==previewStyleKey())this.loadPreview(cx);
    const t=theme(),hasFile=Boolean(this.file);
    const action=(id,glyph,label,fn)=>div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(8)
      .text_color(t.muted).when(true,el=>motion.surface(el,id,t)).cursor_pointer().tooltip(label).on_click(fn)
      .child(svg(`mods/glass-shell/${glyph}.svg`).size(12));
    const tree=v_flex().id("files-tree").min_h(0).overflow_y_scrollbar().px(6).py(8)
      .when(hasFile,e=>e.h(Math.max(130,Math.min(240,(this.height??640)*.34))).flex_none())
      .when(!hasFile,e=>e.flex_1()).children(this.presence.rows(this.rows("",0,[],t),cx))
      .when(Boolean(this.error)||!this.entries.get("")?.length,e=>e.child(div().p(8).text_size(12).text_color(t.muted)
        .child(this.error||(this.loading?"正在读取…":this.root?"暂无文件":"未选择目录"))))
      .when(this.limited,e=>e.child(div().p(8).text_size(11).text_color(t.muted).child("已达到当前显示上限")));
    const body=()=>{
      if(this.fileError)return div().p(10).text_color(t.muted).text_size(12).child(this.fileError);
      if(!this.code)return div().p(10).text_color(t.muted).child("正在读取文件…");
      if(this.markdown&&this.previewMode==="preview")return v_flex().id("markdown-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10)
        .child(TextView.markdown(`markdown-${this.file}`,this.previewText.replace(/!\[([^\]]*)\]\([^)]*\)/g,"[图片：$1]"))
          .selectable(true).w_full().text_color(t.foreground));
      return Editor.new(this.code).flex_1().min_h(0);
    };
    return v_flex().id("files").size_full().min_h(0).rounded(12).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
      .on_size_change((size,cx)=>{if(this.height!==size.height){this.height=size.height;cx.notify();}})
      .child(h_flex().h(32).flex_none().px(14).gap(8).items_center()
        .child(div().font_semibold().child("文件"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.muted).child(this.root?.split(/[\\/]/).pop()??""))
        .child(action("files-refresh","refresh","刷新文件",(_e,cx)=>this.refresh(cx)))
        .child(action("files-panel-close","close","关闭文件面板",()=>run("layout.hide",{id:"tool-panel"}))))
      .when(!this.treeHidden,e=>e.child(tree))
      .when(hasFile,e=>e.child(v_flex().flex_1().min_h(0)
        .child(h_flex().h(32).px(14).gap(8).flex_none().items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().tooltip(this.file).child(this.file.split(/[\\/]/).at(-1)))
          .when(this.markdown,e=>e.child(div().id("preview-mode").px(8).h(24).flex().items_center().rounded(8).text_size(11)
            .text_color(t.muted).hover(e=>e.bg(t.hover)).cursor_pointer()
            .on_click((_e,cx)=>{this.previewMode=this.previewMode==="preview"?"source":"preview";cx.notify();})
            .child(this.previewMode==="preview"?"源码":"预览")))
          .child(action("preview-expand","expand",this.treeHidden?"显示文件列表":"展开预览",(_e,cx)=>{this.treeHidden=!this.treeHidden;cx.notify();}))
          .child(action("preview-close","close","关闭预览",(_e,cx)=>this.show(null,cx))))
        .when(this.truncated,e=>e.child(div().px(10).py(2).text_size(11).text_color(t.muted).child("仅预览前 400,000 个字符")))
        .child(body())))
      .when(!hasFile,e=>e.child(div().px(10).py(8).text_size(11).text_color(t.muted).child("选择文件预览")));
  }
}
