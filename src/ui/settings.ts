import { errorMessage, settingsSet } from "../ipc.ts";
import { settings } from "../state/settings.ts";

type Field = { key: "font_family" | "font_size" | "theme" | "shell"; label: string; input: HTMLInputElement | HTMLSelectElement };

/**
 * The settings window: the common options as a form over the same settings.toml. Each change
 * is written at once and applies live; shortcuts stay in the file (`onEditFile`).
 */
export function openSettings(onEditFile: () => void): void {
  if (document.querySelector(".settings-modal")) return;
  const restore = document.activeElement as HTMLElement | null;
  const s = settings.get();

  const text = (value: string | undefined, placeholder: string) =>
    Object.assign(document.createElement("input"), { value: value ?? "", placeholder, spellcheck: false, autocomplete: "off" });
  const size = Object.assign(text(s.font_size?.toString(), "13"), { type: "number", min: "6", max: "72", step: "1" });
  const theme = document.createElement("select");
  for (const [value, label] of [["system", "Follow system"], ["light", "Light"], ["dark", "Dark"]]) {
    theme.append(Object.assign(document.createElement("option"), { value, textContent: label }));
  }
  theme.value = s.theme ?? "system";

  const fields: Field[] = [
    { key: "font_family", label: "Font", input: text(s.font_family, "SF Mono, Menlo, monospace") },
    { key: "font_size", label: "Font size", input: size },
    { key: "theme", label: "Theme", input: theme },
    { key: "shell", label: "Shell for new tabs", input: text(s.shell, "Your login shell") },
  ];

  const backdrop = Object.assign(document.createElement("div"), { className: "modal-backdrop" });
  const form = Object.assign(document.createElement("form"), { className: "modal settings-modal" });
  form.setAttribute("aria-label", "Settings");
  const error = Object.assign(document.createElement("div"), { className: "modal-error" });
  error.setAttribute("aria-live", "polite");
  const editFile = Object.assign(document.createElement("button"), { type: "button", className: "link-button", textContent: "Shortcuts and more: edit settings.toml" });

  const save = async (f: Field) => {
    const raw = f.input.value.trim();
    // Empty (or the default theme) goes back to the default.
    const value = raw === "" || (f.key === "theme" && raw === "system") ? null : f.key === "font_size" ? Number(raw) : raw;
    try {
      settings.set(await settingsSet(f.key, value));
      error.textContent = "";
    } catch (e) {
      error.textContent = errorMessage(e);
    }
  };

  for (const f of fields) {
    const label = Object.assign(document.createElement("label"), { textContent: f.label });
    label.append(f.input);
    f.input.onchange = () => void save(f);
    form.append(label);
  }
  form.append(error, editFile);
  backdrop.append(form);
  document.body.append(backdrop);

  const close = () => {
    backdrop.remove();
    restore?.focus();
  };
  // Enter saves the focused field and keeps the window open.
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = fields.find((x) => x.input === document.activeElement);
    if (f) void save(f);
  };
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
  fields[0].input.focus();
}
