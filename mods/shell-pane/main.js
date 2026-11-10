// Modified from Herdr pane for Glass Workspace: project-scoped behavior, charcoal surfaces and native transitions.
import { Motion } from "./motion.js";
const motion = new Motion();
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, notify, spaces, shared } from "herdr";

const stop=(_e,cx)=>cx.stop_propagation();
export default class Pane extends View {
  action(pane,command,args={}) {
    try {
      // Always act on this header's pane, never whichever terminal had focus.
      run("pane.focus",{pane});
      if(command==="pane.split") {
        const tab=panes().find(p=>p.pane===pane)?.tab;
        const space=spaces().find(s=>s.tabs.some(t=>t.id===tab));
        run("terminal.open",{place:args.direction,folder:shared("shell.project-roots")?.[space?.id]||space?.folder});
      } else run(command,{...args,pane});
    } catch(e) {notify({title:"终端操作未完成",body:String(e.message??e),level:"warning"});}
  }
  button(t,p,glyph,label,command,args={}) {
    return div().id(`pane-${glyph}-${p.pane}`).w(24).h(24).flex_none().flex().items_center().justify_center().rounded(8)
      .text_color(t.muted).when(true,el=>motion.surface(el,"pane-"+glyph+"-"+p.pane,t))
      .cursor_pointer().tooltip(label).on_mouse_down("left",stop).on_mouse_down("right",stop)
      .on_click((_e,cx)=>{cx.stop_propagation();this.action(p.pane,command,args);})
      .child(svg(`mods/shell-pane/${glyph}.svg`).size(14));
  }
  render() {
    const t=theme(),p=panes().find(p=>p.pane===props()?.pane);
    if(!p)return div();
    const name=p.program?.name||p.title||"终端",pic=p.program?.icon;
    return h_flex().id(`pane-head-${p.pane}`).size_full().px(11).gap(8).items_center()
      .bg(t.background).rounded_t(12).overflow_hidden().text_size(12)
      .on_click(()=>run("pane.focus",{pane:p.pane}))
      .child(h_flex().id(`pane-label-${p.pane}`).flex_1().min_w(0).gap(8).items_center()
        .tooltip(`${name}${p.cwd?" · "+p.cwd:""}\n拖动上边缘中央的手柄可移动窗格`)
        .on_mouse_down("left",(e,cx)=>{cx.stop_propagation();if(e.click_count===2)this.action(p.pane,"pane.zoom");})
        .when(Boolean(pic),el=>el.child(p.program.tint?svg(pic).size(14).flex_none().text_color(t.muted):image(pic).size(14).flex_none()))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(p.focused?t.foreground:t.muted).child(name))
        .when(Boolean(p.status),el=>el.child(div().size(5).flex_none().rounded_full().bg(t[p.status]??t.dim))))
      .child(h_flex().flex_none().gap(2).items_center()
        .child(this.button(t,p,"split-right","左右拆分此终端","pane.split",{direction:"right"}))
        .child(this.button(t,p,"split-down","上下拆分此终端","pane.split",{direction:"down"}))
        .child(this.button(t,p,p.zoomed?"unzoom":"zoom",p.zoomed?"还原分屏":"最大化此终端到工作区","pane.zoom"))
        .child(this.button(t,p,"close","关闭此终端","pane.close")));
  }
}
