/*
 * QuickSendoff, a Vencord userplugin
 * Copyright (c) 2026 xma1Soap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Preset {
    /** 右键菜单里显示的名字 */
    name: string;
    /** 处罚原因，留空则 fox 用默认「违规第三方」 */
    reason: string;
    /** fox 私信模板的值："__none__" = 默认（第三方API），其他填模板文件名，如 "xxx.txt" */
    template: string;
    /** 延迟时间：1m-120m 或 1h-2h */
    delay: string;
    /** gacha 预设消息的完整名称（必须和 gacha 里的名字一字不差；留空则不公示） */
    gachaTitle?: string;
}

export const DEFAULT_PRESETS: Preset[] = [
    { name: "违规第三方API", reason: "违规第三方", template: "__none__", delay: "30m", gachaTitle: "" }
];

export function parsePresets(raw: string): Preset[] {
    try {
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) throw 0;
        return list
            .filter(p => p && typeof p.name === "string" && typeof p.delay === "string")
            .map(p => ({
                name: p.name,
                reason: typeof p.reason === "string" ? p.reason : "",
                template: p.template || "__none__",
                delay: p.delay,
                gachaTitle: typeof p.gachaTitle === "string" ? p.gachaTitle : ""
            }));
    } catch {
        return DEFAULT_PRESETS;
    }
}

const DELAY_RE = /^([1-9]\d*)([mh])$/;

export function validateDelay(delay: string) {
    const m = DELAY_RE.exec(delay);
    const ok = m && ((m[2] === "m" && +m[1] <= 120) || (m[2] === "h" && +m[1] <= 2));
    if (!ok) throw new Error(`延迟时间「${delay}」不合法，只能是 1m-120m 或 1h-2h`);
}
