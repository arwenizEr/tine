import { errorMessage, fsReadFile, settingsSet } from "../ipc.ts";
import { settings } from "../state/settings.ts";

type Key = "font_family" | "font_size" | "theme" | "shell" | "editor";

/** Monospace fonts worth offering; only the installed ones are listed. */
const FONTS = [
  "SF Mono", "Menlo", "Monaco", "Courier New", "JetBrains Mono", "Fira Code", "Source Code Pro", "Hack",
  "Cascadia Code", "IBM Plex Mono", "Roboto Mono", "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono",
  "Inconsolata", "Victor Mono", "Iosevka", "Geist Mono", "MesloLGS NF", "Anonymous Pro",
];

/** A font is installed when text in it measures differently from every generic fallback. */
function installedFonts(): string[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [];
  const width = (font: string) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText("mmmmmmmmmmlli10OQ@#").width;
  };
  const generic = ["monospace", "serif", "sans-serif"];
  const base = generic.map(width);
  return FONTS.filter((name) => generic.some((g, i) => width(`"${name}", ${g}`) !== base[i]));
}

/** Login shells the system allows, from /etc/shells. */
async function systemShells(): Promise<string[]> {
  const { text } = await fsReadFile("/etc/shells").catch(() => ({ text: "" }));
  return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/"));
}

/** Fills `select` with `options` ([value, label]); the current value is kept even if unlisted. */
function fill(select: HTMLSelectElement, options: [string, string][], current: string): void {
  if (current && !options.some(([v]) => v === current)) options.push([current, current]);
  select.replaceChildren(...options.map(([value, textContent]) => Object.assign(document.createElement("option"), { value, textContent })));
  select.value = current;
}

/**
 * The settings window: the common options as dropdowns over the same settings.toml. Each change
 * is written at once and applies live; shortcuts stay in the file (`onEditFile`).
 */
export function openSettings(onEditFile: () => void): void {
  if (document.querySelector(".settings-modal")) return;
  const restore = document.activeElement as HTMLElement | null;
  const s = settings.get();

  const selects = {} as Record<Key, HTMLSelectElement>;
  const backdrop = Object.assign(document.createElement("div"), { className: "modal-backdrop" });
  const form = Object.assign(document.createElement("form"), { className: "modal settings-modal" });
  form.setAttribute("aria-label", "Settings");
  const title = Object.assign(document.createElement("h2"), { textContent: "Settings" });
  const error = Object.assign(document.createElement("div"), { className: "modal-error" });
  error.setAttribute("aria-live", "polite");
  form.append(title);

  for (const [key, label] of [["font_family", "Font"], ["font_size", "Font size"], ["theme", "Theme"], ["shell", "Shell for new tabs"], ["editor", "Open in Editor uses"]] as const) {
    const select = document.createElement("select");
    selects[key] = select;
    select.onchange = async () => {
      // "" is the default: the line goes back to commented out in the file.
      const raw = select.value;
      const value = raw === "" ? null : key === "font_size" ? Number(raw) : raw;
      try {
        settings.set(await settingsSet(key, value));
        error.textContent = "";
      } catch (e) {
        error.textContent = errorMessage(e);
      }
    };
    const el = Object.assign(document.createElement("label"), { textContent: label });
    el.append(select);
    form.append(el);
  }

  fill(selects.font_family, [["", "Default (SF Mono, Menlo)"], ...installedFonts().map((f): [string, string] => [`${f}, monospace`, f])], s.font_family ?? "");
  const sizes: [string, string][] = Array.from({ length: 15 }, (_, i) => String(10 + i)).map((n) => [n, n]);
  fill(selects.font_size, [["", "Default (13)"], ...sizes], s.font_size?.toString() ?? "");
  fill(selects.theme, [["", "Follow system"], ["light", "Light"], ["dark", "Dark"]], s.theme === "system" ? "" : (s.theme ?? ""));
  fill(selects.shell, [["", "Login shell (default)"]], s.shell ?? "");
  fill(selects.editor, [["", "VS Code (default)"], ["cursor", "Cursor"], ["zed", "Zed"]], s.editor === "vscode" ? "" : (s.editor ?? ""));
  void systemShells().then((shells) => fill(selects.shell, [["", "Login shell (default)"], ...shells.map((p): [string, string] => [p, p])], s.shell ?? ""));

  const editFile = Object.assign(document.createElement("button"), { type: "button", className: "link-button", textContent: "Shortcuts and more: edit settings.toml" });
  form.append(error, editFile);
  backdrop.append(form);
  document.body.append(backdrop);

  const close = () => {
    backdrop.remove();
    restore?.focus();
  };
  form.onsubmit = (e) => e.preventDefault();
  form.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  backdrop.onmousedown = (e) => {
    if (e.target === backdrop) close();
  };
  editFile.onclick = () => {
    close();
    onEditFile();
  };
  selects.font_family.focus();
}
