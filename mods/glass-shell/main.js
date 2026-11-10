// Glass Workspace: reserves native macOS window controls and uses platform search hints.
import { Motion, Presence } from "./motion.js";
const motion = new Motion();
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, agents, updates, props as modProps, theme, layout, window, run, notify, openOverlay, nextCommand, shared, setShared, pickFolder, machines } from "herdr";

const ICON = "mods/glass-shell/";
const stop = (_event, cx) => cx.stop_propagation();
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child,id); if(found) return found; }
  return null;
}
function context() {
  const space=spaces().find(s=>s.active);
  const tab=space?.tabs.find(t=>t.active);
  const list=panes().filter(p=>p.tab===tab?.id);
  const pane=list.find(p=>p.pane===focused()?.pane);
  return {space,tab,pane};
}
// Pin project roots separately: native spaces follow a terminal's live cwd.
function projectRoots() {
  const saved=shared("shell.project-roots");
  const roots=saved&&typeof saved==="object"&&!Array.isArray(saved)?{...saved}:{};
  let changed=false;
  const current=spaces(), ids=new Set(current.map(s=>s.id));
  if(machines().length&&machines().every(m=>m.layout==="ready"))for(const id of Object.keys(roots))if(!ids.has(id)){delete roots[id];changed=true;}
  for(const s of current)if(!roots[s.id]&&s.folder){roots[s.id]=s.folder;changed=true;}
  if(changed)setShared("shell.project-roots",roots);
  return roots;
}
function projectFolder(space) { return space ? projectRoots()[space.id]||space.folder : undefined; }
function newTerminal() {
  const {space}=context();
  if(!space){run("glass-shell.project-new");return;}
  run("tab.new",{space:space.id,folder:projectFolder(space)});
}
function currentModule() {
  if(find(layout(),"work-views")?.active==="usage-view")return "usage";
  const panel=find(layout(),"tool-panel");
  return panel&&!panel.hidden?find(layout(),"tool-views")?.active??"terminal":"terminal";
}
function focusWaiting() {
  const list=agents().filter(a=>a.status==="blocked");
  if(!list.length)return;
  const index=list.findIndex(a=>a.pane===focused()?.pane);
  workspace();run("agent.focus",{terminal:list[(index+1)%list.length].address});
}
function workspace() { run("layout.select",{stack:"work-views",child:"workspace-view"}); }
// Layout-scoped keys keep the original action everywhere except the usage view.
function nativeCommand(name) {
  if(!name.startsWith("native-"))return false;
  const [,group,verb,value]=name.split("-");
  if(!["pane","tab","space","agent"].includes(group))return false;
  const command=group+"."+verb, usage=currentModule()==="usage";
  workspace();
  // A first structural key leaves usage; it must never close a hidden terminal.
  if(usage&&["tab.close","pane.close","pane.split","pane.zoom","pane.swap","tab.rename","space.rename"].includes(command))return true;
  const args=value===undefined?{}:verb==="select"?{index:Number(value)}:{direction:value};
  if(command==="space.new")run("glass-shell.project-new");
  else if(command==="tab.new")newTerminal();
  else if(command==="pane.split")run("terminal.open",{place:args.direction,folder:projectFolder(context().space)});
  else run(command,args);
  return true;
}
function selectModule(name, toggle=false) {
  if(name==="usage") {
    if(toggle&&currentModule()==="usage") workspace();
    else {
      run("layout.select",{stack:"work-views",child:"usage-view"});
    }
    return;
  }
  if(name==="terminal") {workspace();return;}
  if(!["files","changes","issues"].includes(name))return;
  const open=currentModule()===name;
  workspace();
  if(toggle&&open) {run("layout.hide",{id:"tool-panel"});return;}
  run("layout.select",{stack:"tool-views",child:name});
  run("layout.show",{id:"tool-panel"});
}

function icon(name,size=17) { return svg(ICON+name+".svg").size(size).flex_none(); }
function iconButton(id,name,label,action,t,active=false) {
  return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(8)
    .text_color(active?t.foreground:t.muted)
    .when(true,el=>motion.surface(el,id,t,active)).cursor_pointer().tooltip(label)
    .on_mouse_down("left",stop).on_mouse_down("right",stop).on_click(action).child(icon(name));
}
function toolButton(id,name,label,action,t,active=false) {
  return h_flex().id(id).h(28).px(8).gap(8).flex_none().items_center().rounded(8)
    .text_color(active?t.foreground:t.muted).text_size(12)
    .when(true,el=>motion.surface(el,id,t,active)).cursor_pointer()
    .on_mouse_down("left",stop).on_click(action).child(icon(name,15)).child(label);
}
function shortPath(value) {
  const path=String(value??"").split(String.fromCharCode(92)).join("/");
  return path.split("/").filter(Boolean).at(-1)||"工作区";
}
function statusLabel(value) { return ({working:"运行中",blocked:"等待操作",done:"已完成",idle:"空闲"})[value]??""; }

export default class GlassShell extends View {
  init(props,cx) {
    this.role=modProps()?.role??props?.role??"tabs";
    this.tabPresence = new Presence("width");
    this.dragged=null;
    if(this.role==="tabs")projectRoots();
    try { this.panels=JSON.parse(localStorage.getItem("tool-panels")??"{}"); } catch { this.panels={}; }
    if(!this.panels||typeof this.panels!=="object"||Array.isArray(this.panels))this.panels={};
    if(this.role==="tabs")this.commands=cx.spawn(async(cx)=>{
      for(;;) {
        let command;try{command=await nextCommand();}catch{break;}
        try {
        const name=String(command).replace(/^glass-shell\./,"");
        if(name==="project-new")this.newProject(cx);
        if(nativeCommand(name)){cx.notify();continue;}
        if(["terminal","files","changes","issues","usage"].includes(name))selectModule(name);
        if(name==="sidebar")run("layout.toggle",{id:"sidebar"});
        if(name==="waiting")focusWaiting();
        if(name==="panel-close")run("layout.hide",{id:"tool-panel"});
        } catch(error) {
          notify({title:"操作未完成",body:String(error.message??error),level:"warning"});
        }
        cx.notify();
      }
    });
  }
  newProject(cx) {
    if(this.pickingProject)return;
    this.pickingProject=true;
    cx.spawn(async cx=>{
      try {
        const folder=await pickFolder({prompt:"选择项目文件夹"});
        if(!folder)return;
        workspace();
        projectRoots();
        run("space.new",{folder,name:shortPath(folder),machine:""});
        projectRoots();
      } catch(error) {notify({title:"项目打开失败",body:String(error.message??error),level:"warning"});}
      finally {this.pickingProject=false;cx.notify();}
    });
  }
  syncPanel(space) {
    const sidebar=find(layout(),"tool-panel"), body=find(layout(),"tool-views");
    if(!space||!sidebar||!body)return;
    const now={child:body.active,hidden:Boolean(sidebar.hidden)};
    if(this.panelSpace!==space.id) {
      const first=this.panelSpace===undefined;
      this.panelSpace=space.id;this.panelPending=null;
      if(!(first&&!(space.id in this.panels))) {
        const saved=this.panels[space.id]??{child:"files",hidden:true};
        const want={child:["files","changes","issues"].includes(saved.child)?saved.child:"files",hidden:Boolean(saved.hidden)};
        if(JSON.stringify(want)!==JSON.stringify(now)) {
          this.panelPending={want,until:Date.now()+1000};
          run("layout.select",{stack:"tool-views",child:want.child});
          run(want.hidden?"layout.hide":"layout.show",{id:"tool-panel"});
          return;
        }
      }
    }
    if(this.panelPending) {
      if(JSON.stringify(this.panelPending.want)!==JSON.stringify(now)&&Date.now()<this.panelPending.until)return;
      this.panelPending=null;
    }
    if(JSON.stringify(this.panels[space.id])===JSON.stringify(now))return;
    this.panels[space.id]=now;
    localStorage.setItem("tool-panels",JSON.stringify(this.panels));
  }
  render(cx) {
    const t=theme();
    if(this.role==="brand")return this.brand(t);
    if(this.role==="sidebar-head")return this.sidebarHead(t);
    if(this.role==="sidebar-foot")return this.sidebarFoot(t);
    if(this.role==="footer")return this.footer(t);
    return this.tabs(t,cx);
  }
  fitToolPanel() {
    const panel=find(layout(),"tool-panel");
    if(!panel||panel.hidden||!this.barWidth)return;
    const limit=Math.max(160,Math.floor(this.barWidth)-204);
    if((panel.size?.px??380)>limit) {
      if(this.panelFit!==limit) {this.panelFit=limit;run("layout.resize",{id:"tool-panel",px:limit});}
    } else this.panelFit=null;
  }
  brand(t) {
    const small=(id,glyph,label,action)=>iconButton(id,glyph,label,action,t).w(24).h(28);
    return h_flex().size_full().px(14).gap(4).items_center()
      .when(window()?.platform === "macos" && !window()?.fullscreen, el => el.pl(76))
      .child(this.windowControls(t))
      .child(small("sidebar-toggle","sidebar","收起侧栏",()=>run("layout.hide",{id:"sidebar"})))
      .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child("Herdr"))
      .child(small("project-prev","arrow-left","上一个项目",()=>{workspace();run("space.prev");}))
      .child(small("project-next","arrow-right","下一个项目",()=>{workspace();run("space.next");}));
  }
  sidebarHead(t) {
    const small=(id,glyph,label,action)=>iconButton(id,glyph,label,action,t).w(26).h(28);
    return h_flex().size_full().px(14).gap(2).items_center()
      .child(h_flex().id("global-search").h(30).flex_1().min_w(0).px(4).gap(8).items_center().rounded(8)
        .text_color(t.muted).text_size(13).when(true,el=>motion.surface(el,"global-search",t))
        .cursor_pointer().tooltip(window()?.platform === "macos" ? "搜索项目与会话 · ⌘P" : "搜索项目与会话 · Ctrl+Shift+K")
        .on_click(()=>run("mod.open",{name:"picker"})).child(icon("search",16)).child("搜索"))
      .child(small("sidebar-sort","filter","Agent 排序与分组",()=>openOverlay({mod:"shell-agents",kind:"popup",width:200,height:140,props:{sortMenu:true}})))
      .child(small("sidebar-project-new","folder-plus","打开项目文件夹",()=>run("glass-shell.project-new")))
      .child(small("sidebar-task-new","compose","新建终端或 Agent",()=>openOverlay({mod:"shell-new-menu",kind:"popup",width:280,height:512,props:{space:context().space?.id}})));
  }
  sidebarFoot(t) {
    const row=(id,glyph,label,filled,action)=>h_flex().id(id).w_full().h(34).flex_none()
      .px(10).gap(10).items_center().rounded(10).text_size(13)
      .bg(filled?t.surface:t.chrome).text_color(filled?t.foreground:t.dim)
      .hover(s=>s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_mouse_down("left",stop).on_click(action)
      .child(icon(glyph,16)).child(div().flex_1().child(label));
    return v_flex().size_full().px(8).py(6).gap(2)
      .child(row("rail-settings","settings","Settings",true,()=>run("app.settings"))
        .tooltip(updates().app.ready?"设置 · 有可用更新":"设置")
        .when(Boolean(updates().app.ready),el=>el.child(div().size(5).rounded_full().bg(t.accent))))
      .child(row("rail-machine","plus","Add machine",false,()=>run("mod.open",{name:"machine-add"})).tooltip("添加远程机器"));
  }

  windowControls(t) {
    const w=window();
    const dot=(name,label,command,color,glyph)=>div().id("window-"+name).w(18).h(28).flex_none().flex().items_center().justify_center()
      .cursor_pointer().tooltip(label).on_mouse_down("left",stop).on_mouse_down("right",stop)
      .on_click(()=>run(command))
      .child(div().size(12).rounded_full().bg(color).flex().items_center().justify_center()
        .text_color(color).hover(s=>s.text_color("#252525")).child(icon(glyph,8)));
    return h_flex().flex_none().gap(2).items_center()
      .when(Boolean(w?.buttons),el=>el
        .child(dot("close","关闭窗口","window.close","#ff5f57","close"))
        .child(dot("minimize","最小化","window.minimize","#febc2e","minimize"))
        .child(dot("maximize",w.maximized?"还原窗口":"最大化","window.maximize","#28c840",w.maximized?"restore":"expand")));
  }
  tabs(t,cx) {
    const {space}=context();
    projectRoots();
    this.syncPanel(space);
    this.fitToolPanel();
    const tabs=space?.tabs??[], all=panes();
    const paneKey=focused()?.pane;
    const activeKey=(space?.id??"")+":"+(tabs.find(tab=>tab.active)?.id??"");
    if(currentModule()==="usage"&&((this.activeKey!==undefined&&this.activeKey!==activeKey)||(this.paneKey&&paneKey&&this.paneKey!==paneKey)))workspace();
    this.activeKey=activeKey;
    this.paneKey=paneKey;
    const tabItem=(tab,index)=>{
      const pane=all.find(p=>p.tab===tab.id&&p.program?.agent)??all.find(p=>p.tab===tab.id);
      const name=tab.named?tab.name:(pane?.program?.name??"终端")+" "+tab.index;
      return h_flex().id("task-"+tab.id).h(28).w(176).flex_none().px(10).gap(8).items_center().rounded(8)
        .text_color(tab.active?t.foreground:t.muted).text_size(12)
        .when(true,el=>motion.surface(el,"task-"+tab.id,t,tab.active))
        .on_mouse_down("left",(e,cx)=>{cx.stop_propagation();this.dragged={id:tab.id,space:space?.id};if(e.click_count===2)run("tab.rename",{id:tab.id});})
        .on_mouse_up("left",()=>{
          const from=this.dragged;this.dragged=null;
          const current=spaces().find(s=>s.active);
          if(!from||from.space!==current?.id||from.space!==space?.id||!current.tabs.some(t=>t.id===from.id))return;
          const target=current.tabs.findIndex(t=>t.id===tab.id);
          if(target<0)return;
          if(from.id!==tab.id)run("tab.move",{id:from.id,index:target+1});
          else {workspace();run("tab.select",{id:tab.id});}
        })
        .on_mouse_down("right",(_e,cx)=>{cx.stop_propagation();openOverlay({mod:"menu",kind:"popup",width:220,props:{tab:"tab",target:{id:tab.id,space:space?.id}}});})
        .child(pane?.program?.icon?(pane.program.tint?svg(pane.program.icon).size(15).text_color(t.muted):image(pane.program.icon).size(15)):icon("terminal",15))
        .child(div().flex_1().min_w(0).truncate().tooltip(name).child(name))
        .when(tab.status==="working",el=>el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)))
        .when(["blocked","done"].includes(tab.status),el=>el.child(div().size(5).rounded_full().bg(t[tab.status])))
        .when(tab.active,el=>el.child(div().id("task-close-"+tab.id).size(18).flex_none().flex().items_center().justify_center().rounded(8)
          .text_color(t.dim).when(true,el=>motion.surface(el,"task-close-"+tab.id,t)).tooltip("关闭此标签")
          .on_mouse_down("left",stop).on_click((_e,cx)=>{cx.stop_propagation();run("tab.close",{id:tab.id});}).child(icon("close",11))));
    };
    const compact=(this.barWidth??1200)<880;
    const tool=(id,glyph,label,action,active)=>compact?iconButton(id,glyph,label,action,t,active):toolButton(id,glyph,label,action,t,active);
    return h_flex().id("context-strip").size_full().px(0).gap(10).items_center()
      .when(Boolean(find(layout(),"sidebar")?.hidden) && window()?.platform === "macos" && !window()?.fullscreen, el => el.pl(66))
      .on_size_change((size,cx)=>{if(this.barWidth!==size.width){this.barWidth=size.width;cx.notify();}})
      .on_mouse_up("left",()=>{this.dragged=null;})
      .on_mouse_down_out(()=>{this.dragged=null;})
      .when(Boolean(find(layout(),"sidebar")?.hidden),el=>el.child(this.windowControls(t)).child(iconButton("show-sidebar","sidebar","展开侧栏",()=>run("layout.show",{id:"sidebar"}),t)))
      .child(h_flex().id("shell-tab-scroll").h_full().flex_1().min_w(0).gap(6).items_center().overflow_x_scrollbar()
        .on_scroll_wheel(e=>{if(Math.abs(e.delta.y)>=1){workspace();run(e.delta.y>0?"tab.prev":"tab.next");}})
        .children(this.tabPresence.rows(tabs.map((tab,index)=>({id:"task-"+tab.id,width:176,render:()=>tabItem(tab,index)})),cx)))
      .child(iconButton("new-task","plus","新建任务标签",()=>openOverlay({mod:"shell-new-menu",kind:"popup",width:280,height:512,props:{space:space?.id}}),t))
      .child(h_flex().flex_none().gap(2).items_center()
        .child(tool("tool-files","folder","文件",()=>selectModule("files",true),currentModule()==="files"))
        .child(tool("tool-changes","branch","Git",()=>selectModule("changes",true),currentModule()==="changes"))
        .child(tool("tool-issues","issue","Issues",()=>selectModule("issues",true),currentModule()==="issues"))
        .child(tool("tool-usage","chart","用量",()=>selectModule("usage",true),currentModule()==="usage")));
  }

  footer(t) {
    const {space,tab,pane}=context(), usage=currentModule()==="usage";
    const folder=pane?.cwd??space?.folder??"";
    const valid=Boolean(pane)&&!usage;
    const footerAction=(id,glyph,label,fn)=>iconButton(id,glyph,label,fn,t);
    return h_flex().size_full().px(10).gap(10).items_center().text_size(11).text_color(t.muted)
      .child(icon(usage?"chart":"folder",13))
      .child(div().flex_1().min_w(0).truncate().tooltip(folder).child(usage?"用量统计":folder||"工作区"))
      .when(Boolean(pane?.branch)&&!usage,el=>el.child(h_flex().gap(8).items_center().child(icon("branch",12)).child(pane.branch)))
      .when(Boolean(pane?.status)&&!usage,el=>el.child(h_flex().gap(8).items_center()
        .child(div().size(5).rounded_full().bg(t[pane.status]??t.dim)).child(statusLabel(pane.status))))
      .child(div().text_color(t.dim).child(space?.machine??"本机"))
      .when(valid,el=>el
        .child(footerAction("split-right","split-right","左右分屏",()=>run("pane.split",{pane:pane.pane,direction:"right"})))
        .child(footerAction("split-down","split-down","上下分屏",()=>run("pane.split",{pane:pane.pane,direction:"down"})))
        .child(footerAction("pane-zoom","expand",pane.zoomed?"恢复分屏":"聚焦当前面板",()=>run("pane.zoom",{pane:pane.pane}))))
      .when(usage,el=>el.child(footerAction("usage-refresh","refresh","刷新用量",()=>run("insights.refresh"))));
  }
}
