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
  const fail = (text: string): void => {
    const wrap = ui.h('div', 'astrbot-loadfail');
    wrap.append(
      ui.placeholder(text),
      ui.button('重试', {
        size: 'sm',
        onClick: () => {
          run();
        },
      }),
    );
    root.replaceChildren(wrap);
  };
  const run = (): void => {
    const gen = ++generation;
    root.replaceChildren(ui.placeholder(opts.loading));
    void opts.load().then(
      (data) => {
        if (gen !== generation || ctx.signal.aborted) return;
        // render 拿到的是运行时 JSON；字段形状不符时不能把整卡留在「正在读取」。
        try {
          const nodes = opts.render(data, run);
          if (gen !== generation || ctx.signal.aborted) return;
          root.replaceChildren(...nodes);
        } catch (err) {
          if (gen !== generation || ctx.signal.aborted) return;
          fail(`${opts.failed}: ${errText(err)}`);
        }
      },
      (err: unknown) => {
        if (gen !== generation || ctx.signal.aborted) return;
        fail(`${opts.failed}: ${errText(err)}`);
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

/** 保存条的可选钩子：保存期间把表单控件也禁掉，避免等待期修改被 reload 吞掉。 */
export interface SaveBarOptions {
  onSaving?(saving: boolean): void;
}

/**
 * 底部保存条：有改动才亮；保存中禁用；结果写一行字并弹一次 toast。
 * 保存进行中 `dirty()` 不会提前解除禁用（并发保存/丢草稿的根因）。
 */
export function saveBar(
  ctx: WebUiPanelContext,
  label: string,
  save: () => Promise<string>,
  opts?: SaveBarOptions,
): SaveBar {
  const { ui } = ctx;
  const msg = ui.msgline('');
  const button = ui.button(label, { variant: 'primary', size: 'sm' });
  const actions = ui.actions();
  actions.append(button);
  const bar = ui.rowbar();
  bar.append(msg, ui.h('span', 'grow'), actions);

  let saving = false;
  let pendingDirty = false;

  const setDisabled = (value: boolean): void => {
    button.disabled = value;
  };
  setDisabled(true);

  button.addEventListener('click', () => {
    if (button.disabled || saving) return;
    saving = true;
    pendingDirty = false;
    setDisabled(true);
    msg.textContent = '正在保存…';
    msg.classList.remove('bad');
    opts?.onSaving?.(true);

    const settle = (): void => {
      saving = false;
      opts?.onSaving?.(false);
    };

    void save().then(
      (text) => {
        const extra = pendingDirty;
        pendingDirty = false;
        settle();
        const done = `${text || '已保存'}${extra ? '（等待期间的改动还没提交）' : ''}`;
        msg.textContent = done;
        msg.classList.remove('bad');
        ctx.ui.toast(done);
      },
      (err: unknown) => {
        const extra = pendingDirty;
        pendingDirty = false;
        settle();
        const text = `保存失败：${errText(err)}${extra ? '；等待期间的改动仍未保存' : ''}`;
        msg.textContent = text;
        msg.classList.add('bad');
        ctx.ui.toast(text, 'bad');
        // 失败后允许重试。
        setDisabled(false);
      },
    );
  });

  return {
    el: bar,
    dirty() {
      if (saving) {
        // 保存中：记下有待保存的改动，但不解除禁用，避免并发保存。
        pendingDirty = true;
        return;
      }
      setDisabled(false);
      msg.textContent = '有未保存的改动';
      msg.classList.remove('bad');
    },
    reset() {
      if (saving) return;
      pendingDirty = false;
      setDisabled(true);
      msg.textContent = '';
      msg.classList.remove('bad');
    },
  };
}
