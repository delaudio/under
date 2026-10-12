export type Key = {
  name: string;
  ctrl: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
};
export class InputOwner {
  mode: "terminal" | "app" | "modal" = "terminal";
  constructor(public prefix = "ctrl+g") {}
  handle(key: Key): "forward" | "consume" | "literal" {
    if (this.mode === "modal") return "consume";
    if (key.ctrl && `ctrl+${key.name}` === this.prefix) {
      if (this.mode === "app") {
        this.mode = "terminal";
        return "literal";
      }
      this.mode = "app";
      return "consume";
    }
    if (this.mode === "app") {
      if (key.name === "escape") this.mode = "terminal";
      return "consume";
    }
    return "forward";
  }
  literal() {
    return new Uint8Array([this.prefix.charCodeAt(5) - 96]);
  }
}
