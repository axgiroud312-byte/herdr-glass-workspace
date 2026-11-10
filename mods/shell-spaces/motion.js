import { div } from "gpui-kit";

const FADE = { duration: 140, easing: "ease-out" };
const RESIZE = { duration: 180, easing: "ease-in-out" };

// Only pointer boundaries enter JavaScript. GPUI interpolates the frames.
// Separate opacity layers let selection remain visible underneath hover.
export class Motion {
  constructor() { this.hovered = new Set(); }
  surface(el, id, t, selected = false, onHover) {
    const over = this.hovered.has(id);
    const layer = (name, color, opacity) => div().id(`${id}-motion-${name}`)
      .absolute().top(0).bottom(0).left(0).right(0).rounded(6)
      .bg(color).opacity(opacity).transition("opacity", FADE);
    return el.relative().rounded(6)
      .active(s => s.opacity(0.76))
      .on_hover((value, cx) => {
        value ? this.hovered.add(id) : this.hovered.delete(id);
        if (onHover) onHover(value, cx);
        cx.notify();
      })
      .child(layer("selected", t.selected, selected ? 1 : 0))
      .child(layer("hover", t.hover, over ? (selected ? 0.4 : 0.8) : 0));
  }
}

// Retain disappearing rows briefly, so both additions and removals animate.
// No polling or frame timers: two one-shot notifications per list change.
export class Presence {
  constructor(axis = "height") { this.items = new Map(); this.started = false; this.axis = axis; }
  rows(items, cx) {
    const keys = new Set(items.map(x => x.id));
    for (const item of items) {
      const old = this.items.get(item.id);
      if (old) { old.item = item; if(old.leaving)old.visible=true; old.leaving = false; }
      else {
        const entry = { item, visible: !this.started, leaving: false };
        this.items.set(item.id, entry);
        if (this.started) cx.timer.after(20, next => {
          if (this.items.get(item.id) === entry && !entry.leaving) { entry.visible = true; next.notify(); }
        });
      }
    }
    for (const [id, entry] of this.items) if (!keys.has(id) && !entry.leaving) {
      entry.leaving = true;
      cx.timer.after(200, next => {
        if (this.items.get(id) === entry && entry.leaving) { this.items.delete(id); next.notify(); }
      });
    }
    const order = items.map(x => this.items.get(x.id));
    for (const entry of this.items.values()) if (entry.leaving) order.splice(Math.min(entry.index ?? order.length, order.length), 0, entry);
    this.started = true;
    return order.map((entry, index) => {
      entry.index = index;
      const { item } = entry, visible = entry.visible && !entry.leaving;
      return div().id(`presence-${item.id}`).flex_none().overflow_hidden()
        .when(this.axis==="height",el=>el.w_full().h(visible?item.height:0))
        .when(this.axis==="width",el=>el.h_full().w(visible?item.width:0).flex().items_center())
        .opacity(visible ? 1 : 0)
        .transition(this.axis, RESIZE).transition("opacity", FADE)
        .child(item.render());
    });
  }
}

export function disclosure(id, open, height, children) {
  return div().id(`disclosure-${id}`).w_full().flex_none().overflow_hidden()
    .h(open ? height : 0).opacity(open ? 1 : 0)
    .transition("height", RESIZE).transition("opacity", FADE).children(children);
}
