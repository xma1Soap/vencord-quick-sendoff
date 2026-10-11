/*
 * QuickSendoff, a Vencord userplugin
 * Copyright (c) 2026 xma1Soap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * 可视化预设编辑器：每个预设一张卡片，填空式编辑，改动即时保存。
 * 只用原生表单元素 + Discord 的 CSS 变量，避免依赖不同版本 Vencord/Discord 的内部组件。
 */

import { useState } from "@webpack/common";

import { fetchGachaPresets } from "./gachaList";
import { describeError } from "./interactions";
import { parsePresets, Preset, validateDelay } from "./presets";
import { getKnownGachaPresets, getKnownTemplates, rememberGachaPresets, settings } from "./settings";

const REASON_SUGGESTIONS = ["违规第三方", "违规云酒馆", "付费平台", "贩子API"];
const DELAY_SUGGESTIONS = ["5m", "10m", "20m", "30m", "60m", "2h"];

const CSS = `
.vc-qs-editor { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
.vc-qs-title { font-size: 16px; font-weight: 600; color: var(--header-primary, #f2f3f5); }
.vc-qs-hint { font-size: 13px; color: var(--text-muted, #949ba4); line-height: 1.5; }
.vc-qs-card {
    border-radius: 8px; padding: 12px 14px;
    background: var(--background-secondary, #2b2d31);
    border: 1px solid var(--background-modifier-accent, #3f4147);
    display: flex; flex-direction: column; gap: 10px;
}
.vc-qs-head { display: flex; align-items: center; gap: 8px; }
.vc-qs-index {
    flex: none; width: 22px; height: 22px; border-radius: 50%;
    display: grid; place-items: center; font-size: 12px; font-weight: 700;
    background: var(--brand-500, #5865f2); color: #fff;
}
.vc-qs-head .vc-qs-input { font-weight: 600; }
.vc-qs-actions { display: flex; gap: 4px; flex: none; }
.vc-qs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.vc-qs-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.vc-qs-field.wide { grid-column: 1 / -1; }
.vc-qs-label { font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--header-secondary, #b5bac1); }
.vc-qs-input, .vc-qs-select {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; font-size: 14px;
    color: var(--text-normal, #dbdee1);
    background: var(--input-background, var(--background-tertiary, #1e1f22));
    border: 1px solid transparent; outline: none;
}
.vc-qs-input:focus, .vc-qs-select:focus { border-color: var(--brand-500, #5865f2); }
.vc-qs-input.bad { border-color: var(--status-danger, #f23f43); }
.vc-qs-err { font-size: 12px; color: var(--text-danger, #f23f43); }
.vc-qs-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.vc-qs-chip {
    padding: 2px 8px; border-radius: 10px; font-size: 12px; cursor: pointer; border: none;
    color: var(--text-normal, #dbdee1); background: var(--background-modifier-hover, #35373c);
}
.vc-qs-chip.on { background: var(--brand-500, #5865f2); color: #fff; }
.vc-qs-btn {
    padding: 4px 10px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none;
    color: var(--text-normal, #dbdee1); background: var(--background-modifier-hover, #35373c);
}
.vc-qs-btn:hover:not(:disabled) { filter: brightness(1.2); }
.vc-qs-btn:disabled { opacity: .4; cursor: default; }
.vc-qs-btn.danger { color: #fff; background: var(--button-danger-background, #da373c); }
.vc-qs-btn.primary { color: #fff; background: var(--brand-500, #5865f2); padding: 8px 14px; align-self: flex-start; }
.vc-qs-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vc-qs-warn { font-size: 12px; color: var(--text-warning, #f0b232); }
.vc-qs-ok { font-size: 12px; color: var(--text-positive, #23a55a); }
@media (max-width: 520px) { .vc-qs-grid { grid-template-columns: 1fr; } }
`;

const blankPreset = (): Preset => ({ name: "新预设", reason: "违规第三方", template: "__none__", delay: "20m", gachaTitle: "" });

function delayError(delay: string) {
    try {
        validateDelay(delay);
        return null;
    } catch (e: any) {
        return e.message as string;
    }
}

export function PresetEditor() {
    const [presets, setPresets] = useState<Preset[]>(() => parsePresets(settings.store.presets));
    const [gachaNames, setGachaNames] = useState<string[]>(() => getKnownGachaPresets());
    const [fetchState, setFetchState] = useState<{ busy: boolean; msg: string; bad?: boolean; }>({ busy: false, msg: "" });
    const templates = getKnownTemplates();

    const refreshGacha = async () => {
        setFetchState({ busy: true, msg: "正在向 gacha 获取预设列表…" });
        try {
            const names = await fetchGachaPresets(settings.store.gachaAppId);
            rememberGachaPresets(names);
            setGachaNames(names);
            setFetchState({ busy: false, msg: `已获取 ${names.length} 条预设` });
        } catch (e: any) {
            setFetchState({ busy: false, msg: `获取失败：${describeError(e)}`, bad: true });
        }
    };

    const save = (next: Preset[]) => {
        setPresets(next);
        settings.store.presets = JSON.stringify(next, null, 2);
    };
    const update = (i: number, patch: Partial<Preset>) => save(presets.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    const move = (i: number, d: number) => {
        const next = [...presets];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        save(next);
    };

    return (
        <div className="vc-qs-editor">
            <style>{CSS}</style>
            <div className="vc-qs-title">送走预设</div>
            <div className="vc-qs-hint">
                每个预设对应右键菜单「一键送走」里的一个选项，改动会自动保存。
                私信模板的列表会在每次实际调用 fox 时自动和 fox 同步。
            </div>

            <div className="vc-qs-bar">
                <button className="vc-qs-btn" disabled={fetchState.busy} onClick={refreshGacha}>
                    {fetchState.busy ? "获取中…" : "🔄 从 gacha 获取公屏小作文列表"}
                </button>
                <span className={fetchState.bad ? "vc-qs-err" : "vc-qs-hint"}>
                    {fetchState.msg || (gachaNames.length ? `已缓存 ${gachaNames.length} 条` : "需要先打开类脑服务器的任意频道")}
                </span>
            </div>
            <datalist id="vc-qs-gacha-names">
                {gachaNames.map(n => <option key={n} value={n} />)}
            </datalist>

            {presets.map((p, i) => {
                const err = delayError(p.delay);
                const tplKnown = templates.some(t => t.value === p.template);
                return (
                    <div className="vc-qs-card" key={i}>
                        <div className="vc-qs-head">
                            <span className="vc-qs-index">{i + 1}</span>
                            <input
                                className={`vc-qs-input${p.name.trim() ? "" : " bad"}`}
                                value={p.name}
                                placeholder="菜单里显示的名字，例如：违规云酒馆"
                                onChange={e => update(i, { name: e.currentTarget.value })}
                            />
                            <div className="vc-qs-actions">
                                <button className="vc-qs-btn" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                                <button className="vc-qs-btn" title="下移" disabled={i === presets.length - 1} onClick={() => move(i, 1)}>↓</button>
                                <button className="vc-qs-btn" title="复制" onClick={() => save([...presets.slice(0, i + 1), { ...p, name: p.name + " 副本" }, ...presets.slice(i + 1)])}>复制</button>
                                <button className="vc-qs-btn danger" title="删除" disabled={presets.length <= 1} onClick={() => save(presets.filter((_, j) => j !== i))}>删除</button>
                            </div>
                        </div>

                        <div className="vc-qs-grid">
                            <div className="vc-qs-field">
                                <span className="vc-qs-label">处罚原因</span>
                                <input
                                    className="vc-qs-input"
                                    value={p.reason}
                                    maxLength={100}
                                    placeholder="留空则为「违规第三方」"
                                    onChange={e => update(i, { reason: e.currentTarget.value })}
                                />
                                <div className="vc-qs-chips">
                                    {REASON_SUGGESTIONS.map(r => (
                                        <button key={r} className={`vc-qs-chip${p.reason === r ? " on" : ""}`} onClick={() => update(i, { reason: r })}>{r}</button>
                                    ))}
                                </div>
                            </div>

                            <div className="vc-qs-field">
                                <span className="vc-qs-label">延迟时间</span>
                                <input
                                    className={`vc-qs-input${err ? " bad" : ""}`}
                                    value={p.delay}
                                    maxLength={4}
                                    placeholder="1m-120m 或 1h-2h"
                                    onChange={e => update(i, { delay: e.currentTarget.value.trim() })}
                                />
                                <div className="vc-qs-chips">
                                    {DELAY_SUGGESTIONS.map(d => (
                                        <button key={d} className={`vc-qs-chip${p.delay === d ? " on" : ""}`} onClick={() => update(i, { delay: d })}>{d}</button>
                                    ))}
                                </div>
                                {err && <span className="vc-qs-err">{err}</span>}
                            </div>

                            <div className="vc-qs-field">
                                <span className="vc-qs-label">私信模板（fox 私发的小作文）</span>
                                <select className="vc-qs-select" value={p.template} onChange={e => update(i, { template: e.currentTarget.value })}>
                                    {templates.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    {!tplKnown && <option value={p.template}>{p.template}（fox 上暂未见到）</option>}
                                </select>
                            </div>

                            <div className="vc-qs-field">
                                <span className="vc-qs-label">公屏小作文（gacha 预设名）</span>
                                <input
                                    className="vc-qs-input"
                                    list="vc-qs-gacha-names"
                                    value={p.gachaTitle ?? ""}
                                    placeholder={gachaNames.length ? "输入关键字筛选，或留空只送走" : "留空则只送走、不公示"}
                                    onChange={e => update(i, { gachaTitle: e.currentTarget.value })}
                                />
                                {!!p.gachaTitle && gachaNames.length > 0 && (
                                    gachaNames.includes(p.gachaTitle)
                                        ? <span className="vc-qs-ok">✓ gacha 里有这篇</span>
                                        : <span className="vc-qs-warn">gacha 列表里没有这个名称，发送时会失败</span>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}

            <button className="vc-qs-btn primary" onClick={() => save([...presets, blankPreset()])}>＋ 新增预设</button>
        </div>
    );
}
