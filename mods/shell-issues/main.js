// Read-only GitHub Issues. Every request is scoped to a captured project.
import { Motion } from "./motion.js";
const motion = new Motion();
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView } from "gpui-base";
import { spaces, shared, exec, run, props, theme, layout } from "herdr";

const LIST_FIELDS="number,title,state,stateReason,updatedAt,labels,url";
const DETAIL_FIELDS=LIST_FIELDS+",body,author,assignees,comments,createdAt,closedAt";
const glyph=(name,size=15)=>svg(`mods/glass-shell/${name}.svg`).size(size).flex_none();
function location() {
  const p=props(),s=spaces().find(s=>s.active);
  return {repo:p?.repo||null,cwd:s?(shared("shell.project-roots")?.[s.id]||s.folder):null,on:s?.machine??null,space:s?.id};
}
const contextKey=()=>JSON.stringify(location());
function find(n,id){if(n?.id===id)return n;for(const c of n?.children??[]){const f=find(c,id);if(f)return f;}return null;}
function visible(){return Boolean(props()?.repo)||(!find(layout(),"tool-panel")?.hidden&&find(layout(),"tool-views")?.active==="issues"&&find(layout(),"work-views")?.active==="workspace-view");}
function stateOf(issue,t) {
  if(issue.state==="OPEN")return {label:"未完成",color:t.ansi2,icon:"issue"};
  if(issue.stateReason==="COMPLETED")return {label:"已完成",color:t.ansi5,icon:"issue-done"};
  if(issue.stateReason==="NOT_PLANNED")return {label:"不计划处理",color:t.muted,icon:"issue-cancel"};
  return {label:"已关闭",color:t.muted,icon:"issue-done"};
}
function date(value){const d=new Date(value);return Number.isNaN(d.getTime())?"":`${d.getMonth()+1}月${d.getDate()}日`;}
function failure(message) {
  const s=String(message);
  if(/not a git repository|not a git directory/i.test(s))return "这个项目文件夹还不是 Git 仓库";
  if(/not logged|auth login|authentication|HTTP 401/i.test(s))return "需要先登录 GitHub：gh auth login";
  if(/no git remotes|none of the git remotes|not.*github/i.test(s))return "这个项目还没有关联 GitHub 仓库";
  if(/could not resolve|404|not found|403|permission/i.test(s))return "无法访问仓库，请检查 GitHub 登录和仓库权限";
  return "读取失败，请检查网络和 GitHub CLI 后重试";
}
function iconButton(id,icon,label,action,t) {
  return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(8)
    .text_color(t.muted).when(true,el=>motion.surface(el,id,t)).cursor_pointer().tooltip(label).on_click(action).child(glyph(icon,14));
}
function pill(issue,t) {
  const state=stateOf(issue,t);
  return h_flex().px(8).py(4).gap(6).rounded(8).bg(t.raised).items_center().text_size(11).text_color(state.color)
    .child(glyph(state.icon,13)).child(state.label);
}
function markdown(id,text,t) {
  const safe=String(text||"").replace(/!\[([^\]]*)\]\(([^)]*)\)/g,"[查看图片：$1]($2)");
  return TextView.markdown(id,safe).selectable(true).w_full().text_size(13).text_color(t.foreground)
    .on_link_click((url,cx)=>{if(/^https?:\/\//i.test(url))cx.open_url(url);});
}

export default class Issues extends View {
  init(_props,cx) {
    this.items=[];this.filter="open";this.limit=100;this.generation=0;this.detailGeneration=0;this.lastRead=0;
    this.query="";this.input=InputState.new({placeholder:"搜索标题或 #编号"});
    this.input.on("change",(_e,cx)=>{this.query=this.input.value();cx.notify();});
    this.load(cx);
    cx.timer.every(60000,cx=>{if(visible()&&!this.loading&&!this.selected)this.load(cx);});
  }
  async gh(args,context) {
    const r=await exec("gh",args,{cwd:context.cwd||undefined,on:context.on});
    if(r.code!==0)throw new Error(r.stderr||r.stdout||"GitHub CLI failed");
    return JSON.parse(r.stdout);
  }
  load(cx) {
    const key=contextKey(),context=location(),changed=key!==this.key;
    if(this.loading&&!changed)return;
    if(changed){this.key=key;this.items=[];this.repo=null;this.selected=null;this.detail=null;this.detailGeneration++;this.limit=100;this.query="";this.input.set_value("");}
    const generation=++this.generation;
    this.loading=true;this.error=null;this.lastRead=Date.now();
    cx.spawn(async cx=>{
      try {
        if(!context.repo&&!context.cwd)throw new Error("not a git repository");
        const repo=context.repo||(await this.gh(["repo","view","--json","nameWithOwner"],context)).nameWithOwner;
        if(generation!==this.generation||key!==contextKey())return;
        this.repo=repo;
        const items=await this.gh(["issue","list","--repo",repo,"--state",this.filter,"--limit",String(this.limit),"--search","sort:updated-desc","--json",LIST_FIELDS],context);
        if(generation!==this.generation||key!==contextKey())return;
        this.items=items;this.updated=Date.now();
      } catch(e){if(generation===this.generation&&key===contextKey())this.error=failure(e.message??e);}
      finally {if(generation===this.generation){this.loading=false;cx.notify();}}
    });
  }
  select(issue,cx) {
    this.selected=issue;this.detail=null;this.detailError=null;this.reading=true;
    const generation=++this.detailGeneration,key=this.key,context=location(),repo=this.repo;
    cx.spawn(async cx=>{
      try {
        const detail=await this.gh(["issue","view",String(issue.number),"--repo",repo,"--json",DETAIL_FIELDS],context);
        if(generation!==this.detailGeneration||key!==contextKey())return;
        this.detail=detail;this.selected=detail;
        this.items=this.items.map(i=>i.number===detail.number?{...i,...detail}:i);
      }catch(e){if(generation===this.detailGeneration&&key===contextKey())this.detailError=failure(e.message??e);}
      finally {if(generation===this.detailGeneration){this.reading=false;cx.notify();}}
    });
    cx.notify();
  }
  back(cx){this.detailGeneration++;this.selected=null;this.detail=null;this.reading=false;this.detailError=null;cx.notify();}
  labels(labels,t) {
    return h_flex().flex_wrap().gap(4).children((labels||[]).map(l=>div().px(6).py(2).rounded(8).bg(t.raised).text_color(t.muted).text_size(10).child(l.name)));
  }
  row(issue,t) {
    const state=stateOf(issue,t);
    return h_flex().id(`issue-${issue.number}`).px(8).py(10).gap(10).flex_none().items_start().rounded(6).when(true,el=>motion.surface(el,"issue-"+issue.number,t)).cursor_pointer()
      .on_click((_e,cx)=>this.select(issue,cx))
      .child(div().pt(2).text_color(state.color).child(glyph(state.icon,16)))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(issue.title))
        .child(h_flex().flex_wrap().gap(8).text_size(11).text_color(t.dim)
          .child(`#${issue.number}`).child(div().text_color(state.color).child(state.label)).child(`${date(issue.updatedAt)}更新`))
        .when(Boolean(issue.labels?.length),e=>e.child(this.labels(issue.labels.slice(0,3),t))));
  }
  detailView(t) {
    const i=this.detail||this.selected;
    return v_flex().id(`issue-detail-${i.number}`).flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(16).gap(16)
      .child(v_flex().gap(10).pt(10)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(i.title))
        .child(h_flex().flex_wrap().gap(8).items_center().child(pill(i,t)).child(div().text_size(11).text_color(t.dim).child(`#${i.number}`)))
        .when(Boolean(this.detail),e=>e.child(div().text_size(11).text_color(t.muted).child(`${i.author?.login||"未知作者"} · ${date(i.createdAt)}创建`)))
        .when(Boolean(i.labels?.length),e=>e.child(this.labels(i.labels,t))))
      .when(Boolean(this.reading),e=>e.child(div().text_color(t.muted).child("正在读取详情…")))
      .when(Boolean(this.detailError),e=>e.child(div().text_color(t.ansi1).child(this.detailError)))
      .when(Boolean(this.detail),e=>e
        .child(markdown(`issue-body-${i.number}`,i.body||"暂无描述",t))
        .when(Boolean(i.assignees?.length),e=>e.child(div().text_size(11).text_color(t.muted).child(`负责人：${i.assignees.map(a=>a.login).join("、")}`)))
        .child(h_flex().pt(8).gap(8).items_center().child(div().font_semibold().child("评论")).child(div().text_size(11).text_color(t.dim).child(String(i.comments?.length||0))))
        .when(!i.comments?.length,e=>e.child(div().text_size(12).text_color(t.muted).child("暂无评论")))
        .children((i.comments||[]).map((c,index)=>v_flex().gap(8).py(8)
          .child(h_flex().gap(8).items_center().child(div().font_medium().text_size(12).child(c.author?.login||"未知作者")).child(div().text_size(11).text_color(t.dim).child(date(c.createdAt))))
          .child(markdown(`issue-comment-${i.number}-${index}`,c.body||"（空评论）",t)))));
  }
  render(cx) {
    if(this.key!==contextKey())this.load(cx);
    const t=theme(),q=this.query.trim().toLowerCase();
    const items=this.items.filter(i=>!q||i.title.toLowerCase().includes(q)||String(i.number)===q.replace(/^#/,""));
    return v_flex().id("issues-panel").size_full().min_h(0).rounded(12).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().h(32).px(14).gap(8).flex_none().items_center()
        .when(Boolean(this.selected),e=>e.child(iconButton("issues-back","arrow-left","返回列表",(_e,cx)=>this.back(cx),t)))
        .child(div().font_semibold().child("Issues"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.muted).tooltip(this.repo||"").child(this.repo||"当前项目"))
        .child(iconButton("issues-refresh","refresh","刷新",(_e,cx)=>{if(this.selected)this.select(this.selected,cx);else this.load(cx);},t))
        .child(iconButton("issues-close","close","关闭 Issues 面板",()=>run("layout.hide",{id:"tool-panel"}),t)))
      .when(Boolean(this.selected),e=>e.child(this.detailView(t)))
      .when(!this.selected,e=>e
        .child(v_flex().px(14).pt(10).pb(8).gap(10).flex_none()
          .child(h_flex().h(30).p(2).gap(2).items_center().rounded(8).bg(t.chrome)
            .children([["open","未完成"],["closed","已关闭"],["all","全部"]].map(([key,label])=>div().id(`issues-filter-${key}`).flex_1().h(26).flex().items_center().justify_center().rounded(8)
              .when(true,el=>motion.surface(el,"issues-filter-"+key,t,this.filter===key)).text_color(this.filter===key?t.foreground:t.muted).text_size(12).cursor_pointer()
              .on_click((_e,cx)=>{if(this.filter===key)return;this.filter=key;this.limit=100;this.generation++;this.loading=false;this.items=[];this.load(cx);cx.notify();}).child(label))))
          .child(h_flex().h(30).px(8).gap(8).items_center().rounded(8).bg(t.raised).child(glyph("search",14)).child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
          .child(div().text_size(11).text_color(t.dim).child(this.loading?"正在刷新…":this.error?(this.items.length?"刷新失败，保留上次结果":""):q?`${items.length} 条匹配结果`:`${items.length} 条 · 最近更新优先`)))
        .when(Boolean(this.error),e=>e.child(v_flex().px(18).py(18).gap(10).child(div().text_color(t.muted).child(this.error))
          .when(!this.repo,e=>e.child(div().text_size(12).text_color(t.dim).child("选择关联 GitHub 仓库的项目后，这里会显示它的 Issues。")))))
        .child(v_flex().id("issue-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(12)
          .children(items.map(i=>this.row(i,t)))
          .when(!items.length&&!this.loading&&!this.error,e=>e.child(v_flex().px(14).py(28).gap(10).items_center().text_color(t.muted).child(glyph("issue",26)).child(q?"已加载列表中没有匹配项":this.filter==="open"?"没有未完成的 Issue":"暂无 Issue")))
          .when(this.items.length>=this.limit,e=>e.child(div().id("issues-more").h(32).mx(8).rounded(8).flex().items_center().justify_center().text_color(t.muted).when(true,el=>motion.surface(el,"issues-more",t)).cursor_pointer()
            .on_click((_e,cx)=>{if(!this.loading){this.limit+=100;this.load(cx);}}).child("加载更多")))))
      .when(Boolean(this.selected?.url),e=>e.child(h_flex().h(40).px(14).flex_none().items_center().justify_between()
        .child(div().text_size(11).text_color(t.dim).child("只读查看"))
        .child(div().id("issue-browser").h(28).px(8).rounded(8).flex().items_center().text_size(12).text_color(t.muted).when(true,el=>motion.surface(el,"issue-browser",t)).cursor_pointer()
          .on_click((_e,cx)=>{if(/^https?:\/\//.test(this.selected?.url||""))cx.open_url(this.selected.url);}).child("在 GitHub 打开 ↗"))));
  }
}
