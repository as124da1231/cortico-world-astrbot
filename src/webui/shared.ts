/**
 * Coo 侧「连接」面板的共用件：取数骨架和保存条。
 *
 * 只处理 World 自己的配置；AstrBot 的群聊/私聊/工具/语音不在这里重复。
 */

import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AutoloadOptions<T> {
  loading: string;
  failed: string;
  load(): Promise<T>;
  render(data: T, reload: () => void): Node[];
}

export function autoload<T>(ctx: WebUiPanelContext, opts: AutoloadOptions<T>): void {
  const { ui, root } = ctx;
  let generation = 0;
  const run = (): void => {
    const gen = ++generation;
    root.replaceChildren(ui.placeholder(opts.loading));
    void opts.load().then(
      (data) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(...opts.render(data, run));
      },
      (err: unknown) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(ui.placeholder(`${opts.failed}: ${errText(err)}`));
      },
    );
  };
  run();
}

export interface SaveBar {
  el: HTMLElement;
  dirty(): void;
  reset(): void;
}

/** 底部保存条：有改动才亮；保存中禁用；结果写一行字并弹一次 toast。 */
export function saveBar(
  ctx: WebUiPanelContext,
  label: string,
  save: () => Promise<string>,
): SaveBar {
  const { ui } = ctx;
  const msg = ui.msgline('');
  const button = ui.button(label, { variant: 'primary', size: 'sm' });
  const actions = ui.actions();
  actions.append(button);
  const bar = ui.rowbar();
  bar.append(msg, ui.h('span', 'grow'), actions);

  const setDisabled = (value: boolean): void => {
    button.disabled = value;
  };
  setDisabled(true);

  button.addEventListener('click', () => {
    if (button.disabled) return;
    setDisabled(true);
    msg.textContent = '';
    void save().then(
      (text) => {
        const done = text || '已保存';
        msg.textContent = done;
        msg.classList.remove('bad');
        ctx.ui.toast(done);
      },
      (err: unknown) => {
        const text = `保存失败：${errText(err)}`;
        msg.textContent = text;
        msg.classList.add('bad');
        ctx.ui.toast(text, 'bad');
        setDisabled(false);
      },
    );
  });

  return {
    el: bar,
    dirty() {
      setDisabled(false);
      msg.textContent = '有未保存的改动';
      msg.classList.remove('bad');
    },
    reset() {
      setDisabled(true);
      msg.textContent = '';
      msg.classList.remove('bad');
    },
  };
}
